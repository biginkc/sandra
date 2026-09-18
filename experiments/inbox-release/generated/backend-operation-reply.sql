-- GENERATED RELEASE OPERATION/REPLY PACKET. No production execution authorization.
-- Target is the explicitly marked HTTP fixture database only.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
-- Pinned operation_foundation: experiments/inbox-operation-acceptance/setup.sql
-- source_sha256=37218be75c5c6b6aec0e4320b6189fc6687b674c72eb04f86ff2d37447fad012
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



-- Pinned saved_actions_setup: experiments/inbox-saved-actions/setup.sql
-- source_sha256=3f06c8764459f06867f0803e74499ee7c982aecf5fc087d05b0f18aedb864b16
-- Personal saved-action definitions (DoD#3 backend). Immutable per-version
-- rows feeding the EXISTING `saved` seam in action-definition.ts
-- (parseInboxActionIntent's 3rd argument). No picker/builder UI, no
-- promotion, no unknown dismiss/restore here — those are separate pieces.
-- Mirrors inbox_action_api/inbox_operations idioms: private schema,
-- REVOKE ALL, org_id+requester_id in keys, immutable_row() trigger,
-- inbox_action_api.authorize(o,u) for membership, SECURITY DEFINER public
-- wrappers added in public-api.sql.

CREATE SCHEMA inbox_saved_actions;
REVOKE ALL ON SCHEMA inbox_saved_actions FROM PUBLIC,anon,authenticated,service_role;

-- Personal visibility only: requester_id scopes every read/write. Shared/team
-- visibility is a separate product decision (dev-plan P3), not built here.
-- Each edit/deactivate INSERTs a new version row; existing version rows are
-- never UPDATEd — immutable_row() (already installed by inbox_operations)
-- blocks that at the trigger level. A "delete" (deactivate) inserts a
-- tombstone version with is_active=false; it never touches an already
-- accepted operation, which only ever holds a frozen detached copy of the
-- definition (action-definition.ts's `definition(saved.definition)`).
CREATE TABLE inbox_saved_actions.definitions (
 org_id uuid NOT NULL,
 id uuid NOT NULL,
 requester_id uuid NOT NULL,
 version integer NOT NULL CHECK (version>0),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
 definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object' AND octet_length(definition::text)<=131072),
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (org_id,id,version),
 UNIQUE (org_id,requester_id,id,version)
);
ALTER TABLE inbox_saved_actions.definitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_saved_actions.definitions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER immutable_saved_action_version BEFORE UPDATE OR DELETE ON inbox_saved_actions.definitions
 FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();

-- Reference validation, reused at SAVE (create/update) and again at EXECUTE
-- (every get() call, which is what the TS glue calls immediately before
-- feeding the snapshot into parseInboxActionIntent). Mirrors the allowed
-- step-type/ordering/gating rules inbox_action_api.prepare() enforces for
-- the metadata lane (experiments/inbox-operation-preparation/setup.sql):
-- only 'outcome'+'assign' are wired to an executor today; 'promote',
-- 'dismiss_unknown' and 'restore_unknown' are typed in action-definition.ts
-- but have no executor, so they remain disabled gated step types here.
-- 'review_reply' hands off to the separate reply prepare/accept lane and may
-- only ever appear alone. dnc stays permanently gated off.
CREATE FUNCTION inbox_saved_actions.validate_definition(o uuid,definition jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE step jsonb;types text[];assignee uuid;
BEGIN
 IF jsonb_typeof(definition) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(definition))<>2
  OR definition->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(definition->'steps') IS DISTINCT FROM 'array'
  OR jsonb_array_length(definition->'steps') NOT BETWEEN 1 AND 5 THEN
  RAISE EXCEPTION 'INBOX_SAVED_ACTION_INVALID_DEFINITION';
 END IF;
 SELECT array_agg(value->>'type') INTO types FROM jsonb_array_elements(definition->'steps');
 IF 'review_reply'=ANY(types) THEN
  IF array_length(types,1)<>1 THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_STEP_COMBINATION_UNSUPPORTED';END IF;
  step:=definition->'steps'->0;
  IF jsonb_typeof(step) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(step))<>2 OR NOT(step ? 'text')
   OR jsonb_typeof(step->'text') IS DISTINCT FROM 'string' OR length(step->>'text') NOT BETWEEN 1 AND 1600 THEN
   RAISE EXCEPTION 'INBOX_SAVED_ACTION_INVALID_DEFINITION';
  END IF;
  RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM unnest(types) t WHERE t NOT IN ('outcome','assign')) THEN
  RAISE EXCEPTION 'INBOX_SAVED_ACTION_STEP_TYPE_DISABLED';
 END IF;
 IF array_length(types,1)>2 OR (SELECT count(*) FROM unnest(types) t WHERE t='outcome')>1 OR (SELECT count(*) FROM unnest(types) t WHERE t='assign')>1 THEN
  RAISE EXCEPTION 'INBOX_SAVED_ACTION_STEP_COMBINATION_UNSUPPORTED';
 END IF;
 IF array_length(types,1)=2 AND types[1]<>'outcome' THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_STEP_COMBINATION_UNSUPPORTED';END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(definition->'steps') LOOP
  IF step->>'type'='outcome' THEN
   IF jsonb_typeof(step) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(step))<>2 OR NOT(step ? 'value') THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_INVALID_DEFINITION';END IF;
   IF step->>'value'='dnc' THEN RAISE EXCEPTION 'permanent_dnc_not_enabled';END IF;
   IF step->>'value' IS NULL OR step->>'value' NOT IN ('wrong_number','bad_number','not_interested','needs_sequence','nurture','opted_out') THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_INVALID_DEFINITION';END IF;
  ELSIF step->>'type'='assign' THEN
   IF jsonb_typeof(step) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(step))<>2 OR NOT(step ? 'userId') THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_INVALID_DEFINITION';END IF;
   IF jsonb_typeof(step->'userId')='string' THEN
    assignee:=(step->>'userId')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id=assignee AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp())) THEN
     RAISE EXCEPTION 'INBOX_SAVED_ACTION_ASSIGNEE_UNAVAILABLE';
    END IF;
   ELSIF step->'userId' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_INVALID_DEFINITION';
   END IF;
  ELSE RAISE EXCEPTION 'INBOX_SAVED_ACTION_STEP_TYPE_DISABLED';
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION inbox_saved_actions.create(o uuid,u uuid,name text,definition jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_saved_actions.definitions;
BEGIN
 PERFORM inbox_action_api.authorize(o,u);
 IF name IS NULL OR length(btrim(name)) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_INVALID_NAME';END IF;
 PERFORM inbox_saved_actions.validate_definition(o,definition);
 INSERT INTO inbox_saved_actions.definitions(org_id,id,requester_id,version,name,schema_version,definition,is_active)
 VALUES(o,gen_random_uuid(),u,1,btrim(name),1,definition,true) RETURNING * INTO row;
 RETURN jsonb_build_object('id',row.id,'version',row.version,'name',row.name,'definition',row.definition,'org_id',row.org_id,'requester_id',row.requester_id,'is_active',row.is_active,'created_at',row.created_at);
END $$;

CREATE FUNCTION inbox_saved_actions.update(o uuid,u uuid,target_id uuid,name text,definition jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE current inbox_saved_actions.definitions;row inbox_saved_actions.definitions;
BEGIN
 PERFORM inbox_action_api.authorize(o,u);
 IF target_id IS NULL THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_NOT_FOUND';END IF;
 -- Serialize version assignment for this (org,requester,id): the immutable
 -- table has no row to FOR UPDATE-lock across a concurrent INSERT of the
 -- next version, so use the same advisory-lock idiom as
 -- inbox_action_api.lock_request_key.
 PERFORM pg_advisory_xact_lock(hashtextextended('sandra:inbox:saved_action:v1:'||o::text||':'||u::text||':'||target_id::text,0));
 SELECT * INTO current FROM inbox_saved_actions.definitions WHERE org_id=o AND requester_id=u AND id=target_id ORDER BY version DESC LIMIT 1;
 IF NOT FOUND OR NOT current.is_active THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_NOT_FOUND';END IF;
 IF name IS NULL OR length(btrim(name)) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_INVALID_NAME';END IF;
 PERFORM inbox_saved_actions.validate_definition(o,definition);
 INSERT INTO inbox_saved_actions.definitions(org_id,id,requester_id,version,name,schema_version,definition,is_active)
 VALUES(o,target_id,u,current.version+1,btrim(name),1,definition,true) RETURNING * INTO row;
 RETURN jsonb_build_object('id',row.id,'version',row.version,'name',row.name,'definition',row.definition,'org_id',row.org_id,'requester_id',row.requester_id,'is_active',row.is_active,'created_at',row.created_at);
END $$;

CREATE FUNCTION inbox_saved_actions.deactivate(o uuid,u uuid,target_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE current inbox_saved_actions.definitions;row inbox_saved_actions.definitions;
BEGIN
 PERFORM inbox_action_api.authorize(o,u);
 IF target_id IS NULL THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sandra:inbox:saved_action:v1:'||o::text||':'||u::text||':'||target_id::text,0));
 SELECT * INTO current FROM inbox_saved_actions.definitions WHERE org_id=o AND requester_id=u AND id=target_id ORDER BY version DESC LIMIT 1;
 IF NOT FOUND OR NOT current.is_active THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_NOT_FOUND';END IF;
 -- Tombstone version only. Never mutates current/prior rows, never touches
 -- an already accepted operation (which only holds a frozen, detached copy).
 INSERT INTO inbox_saved_actions.definitions(org_id,id,requester_id,version,name,schema_version,definition,is_active)
 VALUES(o,target_id,u,current.version+1,current.name,current.schema_version,current.definition,false) RETURNING * INTO row;
 RETURN jsonb_build_object('id',row.id,'version',row.version,'is_active',row.is_active);
END $$;

CREATE FUNCTION inbox_saved_actions.list(o uuid,u uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM inbox_action_api.authorize(o,u);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'version',d.version,'name',d.name,'definition',d.definition,'created_at',d.created_at) ORDER BY d.name,d.id),'[]') INTO result
 FROM (SELECT DISTINCT ON (id) * FROM inbox_saved_actions.definitions WHERE org_id=o AND requester_id=u ORDER BY id,version DESC) d
 WHERE d.is_active;
 RETURN jsonb_build_object('items',result);
END $$;

-- Requester-scoped read of the EXACT stored immutable version. Re-validates
-- references/gated-step-types at EXECUTE time (P3: "Validate saved-action
-- references... when saved AND again at execution"), and refuses a version
-- that is no longer current (a stale definition edited or deactivated
-- since), so a disabled gated step type or a since-ineligible reference can
-- never be executed through it.
CREATE FUNCTION inbox_saved_actions.get(o uuid,u uuid,target_id uuid,target_version integer) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_saved_actions.definitions;
BEGIN
 PERFORM inbox_action_api.authorize(o,u);
 IF target_id IS NULL OR target_version IS NULL OR target_version<1 THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_NOT_FOUND';END IF;
 SELECT * INTO row FROM inbox_saved_actions.definitions WHERE org_id=o AND requester_id=u AND id=target_id AND version=target_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_NOT_FOUND';END IF;
 IF EXISTS(SELECT 1 FROM inbox_saved_actions.definitions WHERE org_id=o AND requester_id=u AND id=target_id AND version>target_version) THEN
  RAISE EXCEPTION 'INBOX_SAVED_ACTION_STALE_VERSION';
 END IF;
 IF NOT row.is_active THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_NOT_FOUND';END IF;
 PERFORM inbox_saved_actions.validate_definition(o,row.definition);
 RETURN jsonb_build_object('id',row.id,'version',row.version,'name',row.name,'definition',row.definition,'org_id',row.org_id,'requester_id',row.requester_id,'is_active',row.is_active,'created_at',row.created_at);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_saved_actions FROM PUBLIC,anon,authenticated,service_role;



-- Pinned saved_actions_public_api: experiments/inbox-saved-actions/public-api.sql
-- source_sha256=f0229a3e1062c06ba13a7209532579b6eba67d7961b8362b2fc6469999ab369c
-- Session-scoped wrappers + public SECURITY DEFINER grants, mirroring
-- experiments/inbox-operation-preparation/public-api.sql and the
-- assignees()/authorize(NULL) idiom in review.sql.

CREATE FUNCTION inbox_saved_actions.create_for_session(name text,definition jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN a:=inbox_action_api.authorize(NULL); RETURN inbox_saved_actions.create((a->>'org_id')::uuid,(a->>'user_id')::uuid,name,definition); END $$;

CREATE FUNCTION inbox_saved_actions.update_for_session(target_id uuid,name text,definition jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN a:=inbox_action_api.authorize(NULL); RETURN inbox_saved_actions.update((a->>'org_id')::uuid,(a->>'user_id')::uuid,target_id,name,definition); END $$;

CREATE FUNCTION inbox_saved_actions.deactivate_for_session(target_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN a:=inbox_action_api.authorize(NULL); RETURN inbox_saved_actions.deactivate((a->>'org_id')::uuid,(a->>'user_id')::uuid,target_id); END $$;

CREATE FUNCTION inbox_saved_actions.list_for_session() RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN a:=inbox_action_api.authorize(NULL); RETURN inbox_saved_actions.list((a->>'org_id')::uuid,(a->>'user_id')::uuid); END $$;

CREATE FUNCTION inbox_saved_actions.get_for_session(target_id uuid,target_version integer) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN a:=inbox_action_api.authorize(NULL); RETURN inbox_saved_actions.get((a->>'org_id')::uuid,(a->>'user_id')::uuid,target_id,target_version); END $$;

CREATE FUNCTION public.inbox_saved_action_create(name text,definition jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$ SELECT inbox_saved_actions.create_for_session(name,definition) $$;
CREATE FUNCTION public.inbox_saved_action_update(id uuid,name text,definition jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$ SELECT inbox_saved_actions.update_for_session(id,name,definition) $$;
CREATE FUNCTION public.inbox_saved_action_deactivate(id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$ SELECT inbox_saved_actions.deactivate_for_session(id) $$;
CREATE FUNCTION public.inbox_saved_action_list() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$ SELECT inbox_saved_actions.list_for_session() $$;
CREATE FUNCTION public.inbox_saved_action_get(id uuid,version integer) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$ SELECT inbox_saved_actions.get_for_session(id,version) $$;

REVOKE ALL ON FUNCTION public.inbox_saved_action_create(text,jsonb),public.inbox_saved_action_update(uuid,text,jsonb),
 public.inbox_saved_action_deactivate(uuid),public.inbox_saved_action_list(),public.inbox_saved_action_get(uuid,integer)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_saved_action_create(text,jsonb),public.inbox_saved_action_update(uuid,text,jsonb),
 public.inbox_saved_action_deactivate(uuid),public.inbox_saved_action_list(),public.inbox_saved_action_get(uuid,integer)
 TO authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_saved_actions FROM PUBLIC,anon,authenticated,service_role;



-- Pinned operation_domain_setup: experiments/inbox-operation-domain/setup.sql
-- source_sha256=b7ca70de5cfe321ad3996b98de2f6097ba9b0545e7e2eb7bb0c955e9cc2a35ff
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



-- Pinned operation_domain_scope: experiments/inbox-operation-domain/restrictive-scope.sql
-- source_sha256=8b21a491160fedfb84ef85d1156fcede5ffdb8f56855786d430faed1784776d9
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



-- Pinned operation_domain_effect: experiments/inbox-operation-domain/restrictive-effect.sql
-- source_sha256=3e643d1cd5b370f7cea3588a4caf9146a29e25da6eec808b0c4621ca424124df
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



-- Pinned operation_domain_apply: experiments/inbox-operation-domain/restrictive-apply.sql
-- source_sha256=79dec51b3a2e8ed0cd87fc6f4e545a02c0550e539aebaf2edb4d33d152b24ab5
-- Source-only candidate. Replace the private adapter only after reviewed scope/helper installation.
CREATE OR REPLACE FUNCTION inbox_operation_domain.apply_property_step(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE shared_sms inbox_operation_domain.shared_sms_receipts; sms_original_policy jsonb; sms jsonb; sms_expected jsonb; sms_contact uuid; step jsonb; payload jsonb; expected jsonb; actual jsonb; requirements jsonb; prior jsonb; history jsonb; historical jsonb;
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

 -- Rebase every accepted predecessor in order. Each adapter receipt returns
 -- only the dependency namespaces it changed, so the final step must merge
 -- the whole chain rather than just the immediately preceding receipt.
 history:=step->'predecessor_results';
 IF jsonb_typeof(history) IS DISTINCT FROM 'array' THEN
  history:=CASE WHEN prior IS NULL OR prior='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(prior) END;
 END IF;
 FOR historical IN SELECT value FROM jsonb_array_elements(history) LOOP
  IF historical->>'property_id' IS DISTINCT FROM property_id::text OR jsonb_typeof(historical->'revised_dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid predecessor receipt';END IF;
  FOR revised IN SELECT value FROM jsonb_array_elements(historical->'revised_dependencies') LOOP
   IF NOT ((revised->>'namespace' IN ('property_identity','property_policy','property_outcome','property_assignment','property_reviews') AND revised->'key'=jsonb_build_array(property_id)) OR (sms_contact IS NOT NULL AND ((revised->>'namespace' IN ('contact_policy','contact_identity') AND revised->'key'=jsonb_build_array(sms_contact)) OR (revised->>'namespace'='contact_channel_consent' AND revised->'key'=jsonb_build_array(sms_contact,'sms'))))) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key') THEN RAISE EXCEPTION 'Invalid revised dependency';END IF;
   SELECT jsonb_set(expected,'{dependencies}',jsonb_agg(CASE WHEN d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key' THEN revised ELSE d END ORDER BY d->>'namespace',(d->'key')::text)) INTO expected FROM jsonb_array_elements(expected->'dependencies') d;
  END LOOP;
 END LOOP;
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

-- Promotion adapter: preserve the authoritative promote-leads semantics. A
-- promotion is not a status-only convenience: it rechecks the locked
-- property, DNC gate, prospect state, requester access, dependency vector,
-- guarded write, qualified timestamps/actor, and the qualified lead event in
-- one durable step transaction. Already-lead and DNC-locked rows are recorded
-- as successful no-op outcomes so mixed operations expose their partial
-- result without pretending an ineligible row was changed.
CREATE OR REPLACE FUNCTION inbox_operation_domain.apply_promotion_step(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE step jsonb;payload jsonb;expected jsonb;actual jsonb;requirements jsonb;requester uuid;property_id uuid;p public.properties;member public.memberships;changed boolean;outcome text;result jsonb;v bigint;actor_count integer;prior jsonb;history jsonb;historical jsonb;sms jsonb;sms_contact uuid;targets jsonb;target jsonb;target_revision bigint;target_results jsonb:='[]';resolved jsonb;revised jsonb;requirement jsonb;
BEGIN
 step:=inbox_operations.lock_step_for_effect(o,op,s,g);
 IF step->>'action' IS DISTINCT FROM 'promote' THEN RAISE EXCEPTION 'Unsupported promotion effect';END IF;
 SELECT requester_id INTO STRICT requester FROM inbox_operations.operations WHERE org_id=o AND id=op;
 payload:=step->'payload';property_id:=(payload->>'property_id')::uuid;
 IF property_id IS NULL OR NOT EXISTS(SELECT 1 FROM inbox_operations.item_steps m JOIN inbox_operations.items i USING(org_id,operation_id) WHERE m.org_id=o AND m.operation_id=op AND m.step_id=s AND i.exclusion_code IS NULL AND i.target_kind='conversation' AND (i.resolution->>'property_id')::uuid=property_id) THEN RAISE EXCEPTION 'Invalid promotion mapping';END IF;
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=requester FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Access baseline missing';END IF;
 SELECT count(*) INTO actor_count FROM public.memberships WHERE user_id=requester AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp());
 IF actor_count<>1 THEN RAISE EXCEPTION 'Requester membership ambiguous or missing';END IF;
 SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=requester FOR SHARE;
 IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Requester access revoked';END IF;
 prior:=step->'predecessor_result';
 expected:=step->'original_dependencies'->'policy';
 IF expected->>'org_id' IS DISTINCT FROM o::text OR jsonb_typeof(expected->'dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Missing policy vector';END IF;
 history:=step->'predecessor_results';
 IF jsonb_typeof(history) IS DISTINCT FROM 'array' THEN
  history:=CASE WHEN prior IS NULL OR prior='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(prior) END;
 END IF;
 -- An opted-out predecessor carries the only trusted SMS context for later
 -- metadata steps. Preserve that receipt context through promotion so the
 -- following assignment can rebase contact revisions as well as property
 -- revisions. The receipt is immutable and must agree with the prepared scope.
 FOR historical IN SELECT value FROM jsonb_array_elements(history) LOOP
  IF jsonb_typeof(historical->'sms')='object' AND historical->'sms'->>'contact_id' IS NOT NULL THEN
   IF sms_contact IS NOT NULL AND sms_contact::text IS DISTINCT FROM historical->'sms'->>'contact_id' THEN RAISE EXCEPTION 'SMS predecessor contact mismatch';END IF;
   sms:=historical->'sms';sms_contact:=(sms->>'contact_id')::uuid;
  END IF;
 END LOOP;
 IF sms_contact IS NOT NULL AND step->'original_dependencies'->'sms_scope'->>'contact_id' IS DISTINCT FROM sms_contact::text THEN RAISE EXCEPTION 'SMS predecessor contact mismatch';END IF;
 FOR historical IN SELECT value FROM jsonb_array_elements(history) LOOP
  IF historical->>'property_id' IS DISTINCT FROM property_id::text OR jsonb_typeof(historical->'revised_dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid predecessor receipt';END IF;
  FOR revised IN SELECT value FROM jsonb_array_elements(historical->'revised_dependencies') LOOP
   IF NOT ((revised->>'namespace' IN ('property_identity','property_policy','property_outcome','property_assignment','property_reviews') AND revised->'key'=jsonb_build_array(property_id)) OR (sms_contact IS NOT NULL AND ((revised->>'namespace' IN ('contact_policy','contact_identity') AND revised->'key'=jsonb_build_array(sms_contact)) OR (revised->>'namespace'='contact_channel_consent' AND revised->'key'=jsonb_build_array(sms_contact,'sms'))))) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key') THEN RAISE EXCEPTION 'Invalid revised dependency';END IF;
   SELECT jsonb_set(expected,'{dependencies}',jsonb_agg(CASE WHEN d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key' THEN revised ELSE d END ORDER BY d->>'namespace',(d->'key')::text)) INTO expected FROM jsonb_array_elements(expected->'dependencies') d;
  END LOOP;
 END LOOP;
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
  ELSE
   resolved:=inbox_summary_contract.compute(o,(target->>'conversation_id')::uuid,clock_timestamp());
   IF resolved->>'exists' IS DISTINCT FROM 'true' OR resolved->>'property_id' IS DISTINCT FROM property_id::text THEN RAISE EXCEPTION 'Canonical target property changed';END IF;
   target:=target||jsonb_build_object('valid_until',resolved->'next_window_expiry');
  END IF;
  target_results:=target_results||jsonb_build_array(target);
 END LOOP;
 SELECT * INTO p FROM public.properties WHERE org_id=o AND id=property_id FOR UPDATE;
 IF NOT FOUND OR p.deleted_at IS NOT NULL THEN outcome:='missing';
 ELSIF p.is_dnc_locked THEN outcome:='dnc_locked';
 ELSIF p.status IS DISTINCT FROM 'prospect' THEN outcome:='already_lead';
 ELSE
  requirements:=jsonb_build_object('org_id',o,'dependencies',expected->'dependencies');
  SELECT coalesce(jsonb_agg(jsonb_build_object('namespace',d->>'namespace','key',d->'key') ORDER BY d->>'namespace',(d->'key')::text),'[]'::jsonb)
    INTO requirements
    FROM jsonb_array_elements(expected->'dependencies') d;
  actual:=inbox_policy.snapshot(o,requirements);
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Dependency conflict';END IF;
  UPDATE public.properties SET status='new_lead',qualified_at=clock_timestamp(),qualified_by=requester::text,updated_at=clock_timestamp() WHERE org_id=o AND id=property_id AND status='prospect' AND is_dnc_locked=false;
  IF NOT FOUND THEN RAISE EXCEPTION 'Guarded promotion write lost ownership' USING ERRCODE='40001';END IF;
  INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id) VALUES(o,property_id,'user',requester,'qualified',jsonb_build_object('from','prospect','to','new_lead'),'inbox_operation_step',s);
  outcome:='promoted';
 END IF;
 changed:=outcome='promoted';
 SELECT coalesce(jsonb_agg(jsonb_build_object('namespace',d->>'namespace','key',d->'key') ORDER BY d->>'namespace',(d->'key')::text),'[]'::jsonb)
   INTO requirements
   FROM jsonb_array_elements(expected->'dependencies') d;
 actual:=inbox_policy.snapshot(o,requirements);
 SELECT coalesce(jsonb_agg(d ORDER BY d->>'namespace',(d->'key')::text),'[]'::jsonb)
   INTO revised
   FROM jsonb_array_elements(actual->'dependencies') d
  WHERE d->>'namespace'='property_policy' AND d->'key'=jsonb_build_array(property_id);
 result:=jsonb_build_object('property_id',property_id,'action','promote','outcome',outcome,'changed',changed,'revised_dependencies',revised,'target_revisions',target_results,'sms',sms);
 IF EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id=requester AND access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Access expired during effect';END IF;
 PERFORM inbox_operations.finish_step(o,op,s,g,result);
 RETURN result;
END $$;

-- Unknown sender actions consume only the frozen message IDs in the
-- preparation resolution. The worker never looks up a raw sender group to
-- discover additional rows. A newer group revision is tolerated because it
-- can represent an unrelated arrival; rows that became ineligible after
-- preparation are reported as per-message no-op reasons, leaving later
-- arrivals untouched.
CREATE OR REPLACE FUNCTION inbox_operation_domain.apply_unknown_step(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE step jsonb;payload jsonb;group_id uuid;snapshot_raw text;expected_revision bigint;current_revision bigint;requester uuid;member public.memberships;message_id uuid;message jsonb;outcomes jsonb:='[]';changed_count integer:=0;reason text;result jsonb;v bigint;actor_count integer;
BEGIN
 step:=inbox_operations.lock_step_for_effect(o,op,s,g);
 IF step->>'action' NOT IN ('dismiss_unknown','restore_unknown') THEN RAISE EXCEPTION 'Unsupported unknown effect';END IF;
 SELECT requester_id INTO STRICT requester FROM inbox_operations.operations WHERE org_id=o AND id=op;
 payload:=step->'payload';group_id:=(payload->>'sender_group_id')::uuid;snapshot_raw:=payload->>'raw_sender';expected_revision:=(payload->>'revision')::bigint;
 IF group_id IS NULL OR snapshot_raw IS NULL OR expected_revision IS NULL THEN RAISE EXCEPTION 'Invalid unknown snapshot';END IF;
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=requester FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Access baseline missing';END IF;
 SELECT count(*) INTO actor_count FROM public.memberships WHERE user_id=requester AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp());
 IF actor_count<>1 THEN RAISE EXCEPTION 'Requester membership ambiguous or missing';END IF;
 SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=requester FOR SHARE;
 IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Requester access revoked';END IF;
 IF NOT EXISTS(SELECT 1 FROM inbox_message_capture.sender_groups sg WHERE sg.org_id=o AND sg.sender_group_id=group_id AND sg.raw_sender COLLATE "C"=snapshot_raw COLLATE "C") THEN RAISE EXCEPTION 'Unknown sender identity changed';END IF;
 SELECT revision INTO current_revision FROM inbox_message_capture.versions WHERE org_id=o AND namespace='unknown_action' AND target_id=group_id FOR UPDATE;
 IF current_revision IS NULL OR current_revision<expected_revision THEN RAISE EXCEPTION 'Unknown action snapshot changed';END IF;
 -- The sender-group counter also advances for unrelated arrivals and for
 -- state changes to other messages. The accepted scope is the immutable
 -- message_ids array, so a newer counter must not expand or cancel that
 -- scope. Each frozen ID is re-read under its row lock and reports its own
 -- disappearance, reclassification, permission exclusion, or already-state
 -- reason below; newly arrived messages are never selected here.
 FOR message_id IN SELECT value::text::uuid FROM jsonb_array_elements_text(payload->'message_ids') ORDER BY value::text::uuid LOOP
  SELECT to_jsonb(m) INTO message FROM public.messages m WHERE m.org_id=o AND m.id=message_id FOR UPDATE;
  reason:=NULL;
  IF message IS NULL THEN reason:='message_unavailable';
  ELSIF message->>'channel' IS DISTINCT FROM 'sms' OR message->>'direction' IS DISTINCT FROM 'inbound' OR message->>'contact_id' IS NOT NULL OR (message->>'from_address') COLLATE "C" IS DISTINCT FROM snapshot_raw COLLATE "C" THEN reason:='message_no_longer_unknown';
  ELSIF step->>'action'='dismiss_unknown' AND message->>'dismissed_at' IS NOT NULL THEN reason:='already_dismissed';
  ELSIF step->>'action'='restore_unknown' AND message->>'dismissed_at' IS NULL THEN reason:='already_visible';
  ELSE
   IF step->>'action'='dismiss_unknown' THEN UPDATE public.messages SET dismissed_at=clock_timestamp() WHERE org_id=o AND id=message_id AND dismissed_at IS NULL;
   ELSE UPDATE public.messages SET dismissed_at=NULL WHERE org_id=o AND id=message_id AND dismissed_at IS NOT NULL;
   END IF;
   IF FOUND THEN changed_count:=changed_count+1;ELSE reason:='concurrent_state_changed';END IF;
  END IF;
  outcomes:=outcomes||jsonb_build_array(jsonb_build_object('message_id',message_id,'changed',reason IS NULL,'reason',reason));
 END LOOP;
 result:=jsonb_build_object('action',step->>'action','sender_group_id',group_id,'changed_count',changed_count,'message_outcomes',outcomes);
 IF EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id=requester AND access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Access expired during effect';END IF;
 PERFORM inbox_operations.finish_step(o,op,s,g,result);
 RETURN result;
END $$;


-- Pinned operation_setup: experiments/inbox-operation-preparation/setup.sql
-- source_sha256=c4e131938309b88f6d1b6a7ed8216846b551a2287fd0caaad8676c37a0b62917
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
 property_ids uuid[];enrollment_ids uuid[];message_ids uuid[];unknown_group uuid;unknown_raw text;unknown_revision bigint;unknown_action text;row record;prep_id uuid:=gen_random_uuid();hash text;expires timestamptz:=clock_timestamp()+interval '5 minutes';exclusion text;has_sms boolean:=false;has_outcome boolean:=false;has_assignment boolean:=false;has_promotion boolean:=false;metadata_effect_count integer:=0;metadata_ordinal integer:=0;follow_up_template text;
BEGIN
 IF k IS NULL OR canonical_input IS NULL OR octet_length(canonical_input)>131072 THEN RAISE EXCEPTION 'Invalid action input';END IF;
 PERFORM inbox_action_api.assert_json_shape(canonical_input::json);
 intent:=canonical_input::jsonb;
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(intent))<>6 OR NOT(intent ?& ARRAY['purpose','organizationId','requesterId','targets','definition','savedAction']) OR intent->>'purpose' IS DISTINCT FROM 'prepare_action' OR intent->'savedAction' IS DISTINCT FROM 'null'::jsonb OR (SELECT count(*) FROM json_each(canonical_input::json))<>6 THEN RAISE EXCEPTION 'Invalid action envelope';END IF;
 o:=(intent->>'organizationId')::uuid;u:=(intent->>'requesterId')::uuid;
 IF o IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Invalid action actor';END IF;
 a:=inbox_action_api.authorize(o,u);
 definition:=intent->'definition';
 IF jsonb_typeof(definition) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(definition))<>2 OR definition->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(definition->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(definition->'steps') NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Unsupported action definition';END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(definition->'steps') WITH ORDINALITY q(value,position) ORDER BY position LOOP
  IF jsonb_typeof(step) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Unsupported action step';END IF;
  IF step->>'type'='outcome' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(step))<>2 OR has_outcome OR has_assignment OR NOT(step ? 'value') THEN RAISE EXCEPTION 'Invalid action order';END IF;has_outcome:=true;
   IF step->>'value'='dnc' THEN RAISE EXCEPTION 'permanent_dnc_not_enabled';END IF;
   IF step->>'value' IS NULL OR step->>'value' NOT IN ('wrong_number','bad_number','not_interested','needs_sequence','nurture','opted_out') THEN RAISE EXCEPTION 'Unsupported outcome';END IF;
   has_sms:=step->>'value'='opted_out';
  ELSIF step->>'type'='assign' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(step))<>2 OR has_assignment OR NOT(step ? 'userId') THEN RAISE EXCEPTION 'Invalid assignment';END IF;has_assignment:=true;assignee:=(step->>'userId')::uuid;
   IF assignee IS NOT NULL THEN
    PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=assignee FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'assignee_unavailable';END IF;
   END IF;
   IF assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id=assignee AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'assignee_unavailable';END IF;
  ELSIF step->>'type'='promote' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(step))<>1 THEN RAISE EXCEPTION 'Unsupported action step';END IF;
   IF has_promotion OR has_assignment THEN RAISE EXCEPTION 'Invalid action order';END IF;has_promotion:=true;
  ELSIF step->>'type' IN ('dismiss_unknown','restore_unknown') THEN
   IF (SELECT count(*) FROM jsonb_object_keys(step))<>1 THEN RAISE EXCEPTION 'Unsupported action step';END IF;
   IF has_assignment OR has_outcome AND has_assignment THEN RAISE EXCEPTION 'Invalid action order';END IF;
   IF unknown_action IS NOT NULL AND unknown_action IS DISTINCT FROM step->>'type' THEN RAISE EXCEPTION 'Invalid unknown action order';END IF;
   unknown_action:=step->>'type';
  ELSIF step->>'type'='review_reply' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(step))<>2 OR step->>'text' IS NULL OR btrim(step->>'text')='' OR length(btrim(step->>'text'))>1600 THEN RAISE EXCEPTION 'Unsupported review reply step';END IF;
   follow_up_template:=btrim(step->>'text');
  ELSE RAISE EXCEPTION 'Unsupported action step';END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(definition->'steps') s WHERE s->>'type'='review_reply')>1 OR ((SELECT count(*) FROM jsonb_array_elements(definition->'steps') s WHERE s->>'type'='review_reply')=1 AND (definition->'steps'->-1)->>'type'<>'review_reply') THEN RAISE EXCEPTION 'Invalid review reply order';END IF;
 IF jsonb_typeof(intent->'targets') IS DISTINCT FROM 'array' OR jsonb_array_length(intent->'targets') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid bounded targets';END IF;
 IF (SELECT count(DISTINCT (value->>'kind')||':'||(value->>'id')) FROM jsonb_array_elements(intent->'targets'))<>jsonb_array_length(intent->'targets') THEN RAISE EXCEPTION 'Duplicate targets';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(intent->'targets') ORDER BY value->>'kind',value->>'id' LOOP
  IF jsonb_typeof(target) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(target))<>2 OR NOT(target ?& ARRAY['kind','id']) OR target->>'kind' IS NULL OR target->>'kind' NOT IN ('conversation','unknown_sender_group') OR target->>'id' IS NULL THEN RAISE EXCEPTION 'Invalid typed target';END IF;
  PERFORM (target->>'id')::uuid;exclusion:=NULL;resolved:='{}';
  IF target->>'kind'='unknown_sender_group' AND unknown_action IS NULL THEN exclusion:='unsupported_target';
  ELSIF target->>'kind'='unknown_sender_group' THEN
   -- Unknown actions bind a persistent sender-group identity and an exact
   -- message-id workset at prepare time. Raw sender is used only to resolve
   -- this authoritative group; it is never re-expanded by the worker.
   unknown_group:=(target->>'id')::uuid;
   SELECT g.raw_sender INTO unknown_raw FROM inbox_message_capture.sender_groups g WHERE g.org_id=o AND g.sender_group_id=unknown_group FOR SHARE;
   IF unknown_raw IS NULL THEN exclusion:='conversation_unavailable';
   ELSE
    SELECT v.revision INTO unknown_revision FROM inbox_message_capture.versions v WHERE v.org_id=o AND v.namespace='unknown_action' AND v.target_id=unknown_group FOR UPDATE;
    IF unknown_revision IS NULL THEN exclusion:='source_baseline_unavailable';
    ELSE
     SELECT array_agg(q.id ORDER BY q.id) INTO message_ids FROM (SELECT m.id FROM public.messages m WHERE m.org_id=o AND m.channel='sms' AND m.direction='inbound' AND m.contact_id IS NULL AND m.from_address=unknown_raw AND CASE unknown_action WHEN 'dismiss_unknown' THEN m.dismissed_at IS NULL WHEN 'restore_unknown' THEN m.dismissed_at IS NOT NULL ELSE false END ORDER BY m.id LIMIT 501) q;
     IF cardinality(message_ids) IS NULL OR cardinality(message_ids)=0 THEN exclusion:='conversation_unavailable';
     ELSIF cardinality(message_ids)>500 THEN exclusion:='scope_too_large';
     ELSE resolved:=jsonb_build_object('unknown_action',jsonb_build_object('sender_group_id',unknown_group,'raw_sender',unknown_raw,'revision',unknown_revision::text,'message_ids',to_jsonb(message_ids))); END IF;
    END IF;
   END IF;
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
  item:=jsonb_build_object('id',gen_random_uuid(),'kind',target->>'kind','target_id',(target->>'id')::uuid,'resolution',CASE WHEN target->>'kind'='unknown_sender_group' THEN coalesce(resolved->'unknown_action','{}'::jsonb) ELSE jsonb_build_object('property_id',CASE WHEN exclusion IS NULL THEN resolved->>'property_id' END,'valid_until',resolved->'next_window_expiry') END,'exclusion_code',exclusion);
  items:=items||jsonb_build_array(item);
 END LOOP;
 FOR row IN SELECT key,value FROM jsonb_each(plans) ORDER BY key LOOP
  metadata_ordinal:=0;
  FOR step IN SELECT value||jsonb_build_object('ordinal',ordinality-1) FROM jsonb_array_elements(definition->'steps') WITH ORDINALITY LOOP
   -- Unknown-sender commands have no property effect or property payload.
   -- Mixed selections still prepare their frozen sender-group effect in the
   -- separate loop below; never route one through apply_property_step.
   IF step->>'type' NOT IN ('outcome','assign','promote') THEN CONTINUE; END IF;
   step:=step||jsonb_build_object('ordinal',metadata_ordinal);
   SELECT row.value||jsonb_build_object('targets',jsonb_agg(jsonb_build_object('conversation_id',i->>'target_id','revision',v.revision::text,'valid_until',i->'resolution'->'valid_until') ORDER BY i->>'target_id')) INTO plan
    FROM jsonb_array_elements(items) i JOIN inbox_operation_domain.target_versions v ON v.org_id=o AND v.conversation_id=(i->>'target_id')::uuid WHERE i->>'exclusion_code' IS NULL AND i->'resolution'->>'property_id'=row.key;
   effects:=effects||jsonb_build_array(jsonb_build_object('effect_key','property:'||row.key,'ordinal',(step->>'ordinal')::integer,'action',step->>'type','payload',CASE WHEN step->>'type'='outcome' THEN jsonb_build_object('property_id',row.key,'value',step->>'value') WHEN step->>'type'='promote' THEN jsonb_build_object('property_id',row.key) ELSE jsonb_build_object('property_id',row.key,'user_id',step->'userId') END,'dependencies',plan,'item_ids',(SELECT jsonb_agg(i->>'id' ORDER BY i->>'id') FROM jsonb_array_elements(items) i WHERE i->>'exclusion_code' IS NULL AND i->'resolution'->>'property_id'=row.key)));
   metadata_effect_count:=metadata_effect_count+1;metadata_ordinal:=metadata_ordinal+1;
  END LOOP;
 END LOOP;
 IF unknown_action IS NOT NULL THEN
  FOR row IN SELECT i FROM jsonb_array_elements(items) i WHERE i->>'kind'='unknown_sender_group' AND i->>'exclusion_code' IS NULL ORDER BY i->>'target_id' LOOP
   metadata_ordinal:=0;
   -- The item resolution is already the frozen unknown-action snapshot.
   -- Pass that object directly to apply_unknown_step; an extra
   -- resolution.unknown_action lookup would produce a NULL payload.
   effects:=effects||jsonb_build_array(jsonb_build_object('effect_key','unknown:'||(row.i->>'target_id'),'ordinal',metadata_ordinal,'action',unknown_action,'payload',row.i->'resolution','dependencies',jsonb_build_object('unknown_action',row.i->'resolution'),'item_ids',jsonb_build_array(row.i->>'id')));
   metadata_effect_count:=metadata_effect_count+1;metadata_ordinal:=metadata_ordinal+1;
  END LOOP;
 END IF;
 IF assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id=assignee AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'assignee_unavailable';END IF;
 PERFORM inbox_action_api.authorize(o,u);
 hash:=encode(sha256(convert_to('sandra:inbox:action:v1','utf8')||decode('00','hex')||convert_to(canonical_input,'utf8')),'hex');
 INSERT INTO inbox_operations.preparations VALUES(prep_id,o,u,canonical_input,hash,definition,jsonb_build_object('items',items,'effects',effects),expires);
 INSERT INTO inbox_action_api.preparation_requests VALUES(prep_id,o,u,k,hash);
 RETURN jsonb_build_object('preparation_id',prep_id,'idempotency_key',k,'input_hash',hash,'expires_at',expires,'definition',definition,'items',items,'effect_count',jsonb_array_length(effects),'metadata_effect_count',metadata_effect_count,'affected_property_count',(SELECT count(*) FROM jsonb_object_keys(plans)));
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_action_api FROM PUBLIC,anon,authenticated,service_role;



-- Pinned saved_actions_prepare_reference: experiments/inbox-saved-actions/action-prepare-saved-reference.sql
-- source_sha256=8ad5f6977e166ecb2ed91c2f8609728349faaf20c11935d3ef7d1c5fcd72fdf7
-- Astra round-1 blocker #1 fix: the already-deployed inbox_action_api.prepare
-- (experiments/inbox-operation-preparation/setup.sql) reserved the
-- `savedAction` envelope field but hard-required it to be JSON null
-- unconditionally ("intent->'savedAction' IS DISTINCT FROM 'null'::jsonb"),
-- written before any saved-action backend existed. parseInboxActionIntent's
-- `saved` branch (action-definition.ts, unmodified) ALWAYS emits a non-null
-- `{id,version}` savedAction once a snapshot is resolved — so a saved action
-- could never reach prepare()/accept() end-to-end: the RPC unconditionally
-- rejected it as "Invalid action envelope". This widens the shape guard to
-- accept a well-formed `{id,version}` reference (uuid id, positive integer
-- version, exactly those 2 keys), then binds that reference again inside the
-- authoritative SQL transaction. The requester/org-scoped saved-action
-- lookup rejects missing, foreign, stale, and deactivated versions, and the
-- submitted definition must equal the stored immutable definition byte-for-
-- byte as JSONB. The TypeScript glue still resolves the snapshot for normal
-- requests, but the public RPC is independently callable by an authenticated
-- role, so SQL must not trust a shape-valid reference or client definition.
-- All existing definition-shape, target, membership, assignee, and policy
-- checks remain in place after this server-side snapshot binding.


CREATE OR REPLACE FUNCTION inbox_action_api.invalid_saved_action_reference(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT value IS DISTINCT FROM 'null'::jsonb AND (
  jsonb_typeof(value) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(value))<>2
  OR NOT(value ?& ARRAY['id','version'])
  OR jsonb_typeof(value->'id') IS DISTINCT FROM 'string'
  OR (value->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR jsonb_typeof(value->'version') IS DISTINCT FROM 'number'
  OR (value->>'version')::numeric<=0
  OR (value->>'version')::numeric<>trunc((value->>'version')::numeric)
 )
$$;

CREATE OR REPLACE FUNCTION inbox_action_api.prepare(canonical_input text,k uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE intent jsonb; a jsonb;o uuid;u uuid;definition jsonb;saved_action jsonb;stored_saved_action jsonb;step jsonb;target jsonb;resolved jsonb;
 p public.properties;assignee uuid;item jsonb;items jsonb:='[]';effects jsonb:='[]';plans jsonb:='{}';plan jsonb;requirements jsonb;sms_scope jsonb;
 property_ids uuid[];enrollment_ids uuid[];message_ids uuid[];unknown_group uuid;unknown_raw text;unknown_revision bigint;unknown_action text;row record;prep_id uuid:=gen_random_uuid();hash text;expires timestamptz:=clock_timestamp()+interval '5 minutes';exclusion text;has_sms boolean:=false;has_outcome boolean:=false;has_assignment boolean:=false;has_promotion boolean:=false;metadata_effect_count integer:=0;metadata_ordinal integer:=0;follow_up_template text;
BEGIN
 IF k IS NULL OR canonical_input IS NULL OR octet_length(canonical_input)>131072 THEN RAISE EXCEPTION 'Invalid action input';END IF;
 PERFORM inbox_action_api.assert_json_shape(canonical_input::json);
 intent:=canonical_input::jsonb;
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(intent))<>6 OR NOT(intent ?& ARRAY['purpose','organizationId','requesterId','targets','definition','savedAction']) OR intent->>'purpose' IS DISTINCT FROM 'prepare_action' OR inbox_action_api.invalid_saved_action_reference(intent->'savedAction') OR (SELECT count(*) FROM json_each(canonical_input::json))<>6 THEN RAISE EXCEPTION 'Invalid action envelope';END IF;
 o:=(intent->>'organizationId')::uuid;u:=(intent->>'requesterId')::uuid;
 IF o IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Invalid action actor';END IF;
 a:=inbox_action_api.authorize(o,u);
 definition:=intent->'definition';
 IF jsonb_typeof(definition) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(definition))<>2 OR definition->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(definition->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(definition->'steps') NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Unsupported action definition';END IF;
 -- The savedAction reference is an immutable snapshot binding, not a type
 -- marker. Resolve the exact requester/org-scoped row again inside the
 -- authoritative prepare transaction and require the submitted definition to
 -- be that row's stored definition. The TypeScript transport performs the
 -- same lookup for normal requests, but this public RPC is independently
 -- callable by an authenticated role; without this check a caller could
 -- submit any valid definition alongside an existing, stale, foreign, or
 -- fabricated-looking reference and the shape-only guard would accept it.
 -- get() also revalidates the saved definition and rejects stale,
 -- deactivated, missing, or out-of-scope versions before any target work.
 saved_action:=intent->'savedAction';
 IF saved_action IS DISTINCT FROM 'null'::jsonb THEN
  stored_saved_action:=inbox_saved_actions.get(o,u,(saved_action->>'id')::uuid,(saved_action->>'version')::integer);
  IF stored_saved_action->>'id' IS DISTINCT FROM saved_action->>'id'
   OR stored_saved_action->>'version' IS DISTINCT FROM saved_action->>'version'
   OR stored_saved_action->>'org_id' IS DISTINCT FROM o::text
   OR stored_saved_action->>'requester_id' IS DISTINCT FROM u::text
   OR stored_saved_action->'definition' IS DISTINCT FROM definition THEN
   RAISE EXCEPTION 'INBOX_SAVED_ACTION_DEFINITION_MISMATCH';
  END IF;
 END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(definition->'steps') WITH ORDINALITY q(value,position) ORDER BY position LOOP
  IF jsonb_typeof(step) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Unsupported action step';END IF;
  IF step->>'type'='outcome' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(step))<>2 OR has_outcome OR has_assignment OR NOT(step ? 'value') THEN RAISE EXCEPTION 'Invalid action order';END IF;has_outcome:=true;
   IF step->>'value'='dnc' THEN RAISE EXCEPTION 'permanent_dnc_not_enabled';END IF;
   IF step->>'value' IS NULL OR step->>'value' NOT IN ('wrong_number','bad_number','not_interested','needs_sequence','nurture','opted_out') THEN RAISE EXCEPTION 'Unsupported outcome';END IF;
   has_sms:=step->>'value'='opted_out';
  ELSIF step->>'type'='assign' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(step))<>2 OR has_assignment OR NOT(step ? 'userId') THEN RAISE EXCEPTION 'Invalid assignment';END IF;has_assignment:=true;assignee:=(step->>'userId')::uuid;
   IF assignee IS NOT NULL THEN
    PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=assignee FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'assignee_unavailable';END IF;
   END IF;
   IF assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id=assignee AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'assignee_unavailable';END IF;
  ELSIF step->>'type'='promote' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(step))<>1 THEN RAISE EXCEPTION 'Unsupported action step';END IF;
   IF has_promotion OR has_assignment THEN RAISE EXCEPTION 'Invalid action order';END IF;has_promotion:=true;
  ELSIF step->>'type' IN ('dismiss_unknown','restore_unknown') THEN
   IF (SELECT count(*) FROM jsonb_object_keys(step))<>1 THEN RAISE EXCEPTION 'Unsupported action step';END IF;
   IF has_assignment THEN RAISE EXCEPTION 'Invalid action order';END IF;
   IF unknown_action IS NOT NULL AND unknown_action IS DISTINCT FROM step->>'type' THEN RAISE EXCEPTION 'Invalid unknown action order';END IF;
   unknown_action:=step->>'type';
  ELSIF step->>'type'='review_reply' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(step))<>2 OR step->>'text' IS NULL OR btrim(step->>'text')='' OR length(btrim(step->>'text'))>1600 THEN RAISE EXCEPTION 'Unsupported review reply step';END IF;
   follow_up_template:=btrim(step->>'text');
  ELSE RAISE EXCEPTION 'Unsupported action step';END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(definition->'steps') s WHERE s->>'type'='review_reply')>1 OR ((SELECT count(*) FROM jsonb_array_elements(definition->'steps') s WHERE s->>'type'='review_reply')=1 AND (definition->'steps'->-1)->>'type'<>'review_reply') THEN RAISE EXCEPTION 'Invalid review reply order';END IF;
 IF jsonb_typeof(intent->'targets') IS DISTINCT FROM 'array' OR jsonb_array_length(intent->'targets') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid bounded targets';END IF;
 IF (SELECT count(DISTINCT (value->>'kind')||':'||(value->>'id')) FROM jsonb_array_elements(intent->'targets'))<>jsonb_array_length(intent->'targets') THEN RAISE EXCEPTION 'Duplicate targets';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(intent->'targets') ORDER BY value->>'kind',value->>'id' LOOP
  IF jsonb_typeof(target) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(target))<>2 OR NOT(target ?& ARRAY['kind','id']) OR target->>'kind' IS NULL OR target->>'kind' NOT IN ('conversation','unknown_sender_group') OR target->>'id' IS NULL THEN RAISE EXCEPTION 'Invalid typed target';END IF;
  PERFORM (target->>'id')::uuid;exclusion:=NULL;resolved:='{}';
  IF target->>'kind'='unknown_sender_group' AND unknown_action IS NULL THEN exclusion:='unsupported_target';
  ELSIF target->>'kind'='unknown_sender_group' THEN
   unknown_group:=(target->>'id')::uuid;
   SELECT g.raw_sender INTO unknown_raw FROM inbox_message_capture.sender_groups g WHERE g.org_id=o AND g.sender_group_id=unknown_group FOR SHARE;
   IF unknown_raw IS NULL THEN exclusion:='conversation_unavailable';
   ELSE
    SELECT v.revision INTO unknown_revision FROM inbox_message_capture.versions v WHERE v.org_id=o AND v.namespace='unknown_action' AND v.target_id=unknown_group FOR UPDATE;
    IF unknown_revision IS NULL THEN exclusion:='source_baseline_unavailable';
    ELSE
     SELECT array_agg(q.id ORDER BY q.id) INTO message_ids FROM (SELECT m.id FROM public.messages m WHERE m.org_id=o AND m.channel='sms' AND m.direction='inbound' AND m.contact_id IS NULL AND m.from_address=unknown_raw AND CASE unknown_action WHEN 'dismiss_unknown' THEN m.dismissed_at IS NULL WHEN 'restore_unknown' THEN m.dismissed_at IS NOT NULL ELSE false END ORDER BY m.id LIMIT 501) q;
     IF cardinality(message_ids) IS NULL OR cardinality(message_ids)=0 THEN exclusion:='conversation_unavailable';
     ELSIF cardinality(message_ids)>500 THEN exclusion:='scope_too_large';
     ELSE resolved:=jsonb_build_object('unknown_action',jsonb_build_object('sender_group_id',unknown_group,'raw_sender',unknown_raw,'revision',unknown_revision::text,'message_ids',to_jsonb(message_ids))); END IF;
    END IF;
   END IF;
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
  item:=jsonb_build_object('id',gen_random_uuid(),'kind',target->>'kind','target_id',(target->>'id')::uuid,'resolution',CASE WHEN target->>'kind'='unknown_sender_group' THEN coalesce(resolved->'unknown_action','{}'::jsonb) ELSE jsonb_build_object('property_id',CASE WHEN exclusion IS NULL THEN resolved->>'property_id' END,'valid_until',resolved->'next_window_expiry') END,'exclusion_code',exclusion);
  items:=items||jsonb_build_array(item);
 END LOOP;
 FOR row IN SELECT key,value FROM jsonb_each(plans) ORDER BY key LOOP
  metadata_ordinal:=0;
  FOR step IN SELECT value||jsonb_build_object('ordinal',ordinality-1) FROM jsonb_array_elements(definition->'steps') WITH ORDINALITY LOOP
   -- Unknown-sender commands have no property effect or property payload.
   -- Mixed selections still prepare their frozen sender-group effect in the
   -- separate loop below; never route one through apply_property_step.
   IF step->>'type' NOT IN ('outcome','assign','promote') THEN CONTINUE; END IF;
   step:=step||jsonb_build_object('ordinal',metadata_ordinal);
   SELECT row.value||jsonb_build_object('targets',jsonb_agg(jsonb_build_object('conversation_id',i->>'target_id','revision',v.revision::text,'valid_until',i->'resolution'->'valid_until') ORDER BY i->>'target_id')) INTO plan
    FROM jsonb_array_elements(items) i JOIN inbox_operation_domain.target_versions v ON v.org_id=o AND v.conversation_id=(i->>'target_id')::uuid WHERE i->>'exclusion_code' IS NULL AND i->'resolution'->>'property_id'=row.key;
   effects:=effects||jsonb_build_array(jsonb_build_object('effect_key','property:'||row.key,'ordinal',(step->>'ordinal')::integer,'action',step->>'type','payload',CASE WHEN step->>'type'='outcome' THEN jsonb_build_object('property_id',row.key,'value',step->>'value') WHEN step->>'type'='promote' THEN jsonb_build_object('property_id',row.key) ELSE jsonb_build_object('property_id',row.key,'user_id',step->'userId') END,'dependencies',plan,'item_ids',(SELECT jsonb_agg(i->>'id' ORDER BY i->>'id') FROM jsonb_array_elements(items) i WHERE i->>'exclusion_code' IS NULL AND i->'resolution'->>'property_id'=row.key)));
   metadata_effect_count:=metadata_effect_count+1;metadata_ordinal:=metadata_ordinal+1;
  END LOOP;
 END LOOP;
 IF unknown_action IS NOT NULL THEN
  FOR row IN SELECT i FROM jsonb_array_elements(items) i WHERE i->>'kind'='unknown_sender_group' AND i->>'exclusion_code' IS NULL ORDER BY i->>'target_id' LOOP
   metadata_ordinal:=0;
   -- The item resolution is already the frozen unknown-action snapshot.
   -- Pass that object directly to apply_unknown_step; an extra
   -- resolution.unknown_action lookup would produce a NULL payload.
   effects:=effects||jsonb_build_array(jsonb_build_object('effect_key','unknown:'||(row.i->>'target_id'),'ordinal',metadata_ordinal,'action',unknown_action,'payload',row.i->'resolution','dependencies',jsonb_build_object('unknown_action',row.i->'resolution'),'item_ids',jsonb_build_array(row.i->>'id')));
   metadata_effect_count:=metadata_effect_count+1;metadata_ordinal:=metadata_ordinal+1;
  END LOOP;
 END IF;
 IF assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id=assignee AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'assignee_unavailable';END IF;
 PERFORM inbox_action_api.authorize(o,u);
 hash:=encode(sha256(convert_to('sandra:inbox:action:v1','utf8')||decode('00','hex')||convert_to(canonical_input,'utf8')),'hex');
 INSERT INTO inbox_operations.preparations VALUES(prep_id,o,u,canonical_input,hash,definition,jsonb_build_object('items',items,'effects',effects),expires);
 INSERT INTO inbox_action_api.preparation_requests VALUES(prep_id,o,u,k,hash);
 RETURN jsonb_build_object('preparation_id',prep_id,'idempotency_key',k,'input_hash',hash,'expires_at',expires,'definition',definition,'items',items,'effect_count',jsonb_array_length(effects),'metadata_effect_count',metadata_effect_count,'affected_property_count',(SELECT count(*) FROM jsonb_object_keys(plans)));
END $$;

REVOKE ALL ON FUNCTION inbox_action_api.invalid_saved_action_reference(jsonb),inbox_action_api.prepare(text,uuid) FROM PUBLIC,anon,authenticated,service_role;



-- Pinned operation_worker: experiments/inbox-operation-preparation/worker.sql
-- source_sha256=7e9c67e47951abcb0e353d481d51372b9f39ba1fe6ca585189a5d08be5d769b8
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
  -- Dispatch by the immutable prepared action. Each adapter owns its own
  -- canonical locks and receipt semantics; unknown actions receive the exact
  -- message-id workset captured during preparation and never raw-sender
  -- expansion.
  SELECT CASE
   WHEN st.action='promote' THEN 'promote'
   WHEN st.action IN ('dismiss_unknown','restore_unknown') THEN 'unknown'
   ELSE 'property'
  END INTO message
  FROM inbox_operations.steps st WHERE st.org_id=o AND st.operation_id=op AND st.id=s;
  IF message='promote' THEN result:=inbox_operation_domain.apply_promotion_step(o,op,s,g);
  ELSIF message='unknown' THEN result:=inbox_operation_domain.apply_unknown_step(o,op,s,g);
  ELSE result:=inbox_operation_domain.apply_property_step(o,op,s,g);
  END IF;
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
   WHEN 'Unknown action snapshot changed' THEN terminal_state:='conflicted';code:='unknown_action_changed';
   WHEN 'Unknown sender identity changed' THEN terminal_state:='conflicted';code:='unknown_identity_changed';
   WHEN 'message_unavailable' THEN terminal_state:='conflicted';code:='message_unavailable';
   WHEN 'Access baseline missing' THEN terminal_state:='blocked';code:='requester_access_unavailable';
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



-- Pinned operation_accept: experiments/inbox-operation-preparation/accept.sql
-- source_sha256=64e8c37a9c7131e9801231985197ec90fb1071021c88bc613dfb82755968da04
-- Completes the private acceptance assertions using current canonical authority.

CREATE OR REPLACE FUNCTION inbox_operations.assert_request_access(o uuid,u uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN PERFORM inbox_action_api.authorize(o,u);END $$;
CREATE OR REPLACE FUNCTION inbox_operations.assert_current_preparation(p uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE prep inbox_operations.preparations;binding inbox_action_api.preparation_requests;item jsonb;effect jsonb;target jsonb;expected jsonb;requirements jsonb;revision bigint;assignee uuid;unknown_snapshot jsonb;current_message_ids jsonb;unknown_group uuid;unknown_raw text;
BEGIN
 SELECT * INTO prep FROM inbox_operations.preparations WHERE id=p;
 SELECT * INTO binding FROM inbox_action_api.preparation_requests WHERE preparation_id=p;
 IF prep.id IS NULL OR binding.preparation_id IS NULL OR (binding.org_id,binding.requester_id,binding.input_hash) IS DISTINCT FROM (prep.org_id,prep.requester_id,prep.input_hash) THEN RAISE EXCEPTION 'INBOX_ACTION_PREPARATION_UNAVAILABLE';END IF;
 PERFORM inbox_action_api.authorize(prep.org_id,prep.requester_id);
 IF prep.expires_at<=clock_timestamp() OR jsonb_array_length(prep.snapshot->'effects')=0 THEN RAISE EXCEPTION 'INBOX_ACTION_PREPARATION_EXPIRED_OR_EMPTY';END IF;
 FOR effect IN SELECT value FROM jsonb_array_elements(prep.snapshot->'effects') ORDER BY value->>'effect_key',(value->>'ordinal')::integer LOOP
  -- Unknown-sender effects carry a frozen sender-group/message-id snapshot,
  -- not property policy/target dependencies.  Validate that exact snapshot
  -- against current canonical rows before accepting; routing it through the
  -- property policy branch passes NULL requirements to inbox_policy.snapshot
  -- and rejects every otherwise valid unknown dismissal/restoration.
  IF effect->'dependencies' ? 'unknown_action' THEN
   unknown_snapshot:=effect->'dependencies'->'unknown_action';
   IF jsonb_typeof(unknown_snapshot) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(unknown_snapshot))<>4
      OR NOT(unknown_snapshot ?& ARRAY['sender_group_id','raw_sender','revision','message_ids'])
      OR jsonb_typeof(unknown_snapshot->'message_ids') IS DISTINCT FROM 'array'
      OR effect->>'action' NOT IN ('dismiss_unknown','restore_unknown') THEN
    RAISE EXCEPTION 'Unknown action snapshot changed' USING ERRCODE='P0001';
   END IF;
   unknown_group:=(unknown_snapshot->>'sender_group_id')::uuid;
   SELECT g.raw_sender INTO unknown_raw
   FROM inbox_message_capture.sender_groups g
   WHERE g.org_id=prep.org_id AND g.sender_group_id=unknown_group
   FOR SHARE;
   IF unknown_raw IS NULL OR unknown_raw IS DISTINCT FROM unknown_snapshot->>'raw_sender' THEN
    RAISE EXCEPTION 'Unknown sender identity changed' USING ERRCODE='P0001';
   END IF;
   SELECT v.revision INTO revision
   FROM inbox_message_capture.versions v
   WHERE v.org_id=prep.org_id AND v.namespace='unknown_action' AND v.target_id=unknown_group
   FOR UPDATE;
   -- A sender-group revision also advances when a later unknown message
   -- arrives.  That is allowed: the immutable message-id workset below is
   -- the authority for this accepted operation, so later arrivals remain
   -- untouched by the worker.
   IF revision IS NULL OR revision < (unknown_snapshot->>'revision')::bigint THEN
    RAISE EXCEPTION 'Unknown action snapshot changed' USING ERRCODE='P0001';
   END IF;
   SELECT coalesce(jsonb_agg(to_jsonb(m.id) ORDER BY m.id),'[]'::jsonb) INTO current_message_ids
   FROM jsonb_array_elements_text(unknown_snapshot->'message_ids') frozen
   JOIN public.messages m ON m.id=frozen.value::uuid AND m.org_id=prep.org_id
   WHERE m.channel='sms' AND m.direction='inbound'
     AND m.contact_id IS NULL AND m.from_address=unknown_raw
     AND CASE effect->>'action'
       WHEN 'dismiss_unknown' THEN m.dismissed_at IS NULL
       WHEN 'restore_unknown' THEN m.dismissed_at IS NOT NULL
       ELSE false
     END;
   IF current_message_ids IS DISTINCT FROM unknown_snapshot->'message_ids' THEN
    RAISE EXCEPTION 'Unknown action snapshot changed' USING ERRCODE='P0001';
   END IF;
   CONTINUE;
  END IF;
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



-- Pinned operation_public_api: experiments/inbox-operation-preparation/public-api.sql
-- source_sha256=4169ce78710ccddbf33011b7572a95b7c06599016d29df2ec51d1e4ac7f966d8
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
LANGUAGE sql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
 SELECT inbox_action_api.status(operation_id)
$$;
REVOKE ALL ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_accept_action(uuid,uuid),public.inbox_operation_status(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_accept_action(uuid,uuid),public.inbox_operation_status(uuid) TO authenticated;



-- Pinned operation_review_recovery: experiments/inbox-operation-preparation/review.sql
-- source_sha256=78c7a3c4d388f49c5600ab8f76660ad11f6c89d49d652a6c2256f537f4416ede
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
LANGUAGE sql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$ SELECT inbox_action_api.assignees() $$;
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
LANGUAGE sql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$ SELECT inbox_action_api.recover(preparation_id,idempotency_key) $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_action_api FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_action_assignees(),public.inbox_recover_operation(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_action_assignees(),public.inbox_recover_operation(uuid,uuid) TO authenticated;



-- Pinned operation_worker_role: experiments/inbox-operation-preparation/worker-role.sql
-- source_sha256=a686aec664667bf60e2a7507e5fad03508de5bc9d3d49265a3480797d3039948
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



-- Pinned reply_context: experiments/inbox-reply-boundary/context.sql
-- source_sha256=f78d36d03f1d8386a781f200cef6cd2d361735a8dfbc9f4a5f4117c72a536eeb
-- Additional dependencies required by reviewed reply personalization and route
-- inventory. Fixture-only; install through the reviewed production migration.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;
END $$;
CREATE SCHEMA inbox_reply_context AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_reply_context FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_reply_context.versions(
 org_id uuid NOT NULL, namespace text NOT NULL CHECK(namespace IN ('sender_inventory','organization_name','property_market')),
 target_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0), PRIMARY KEY(org_id,namespace,target_id)
);
-- No canonical FK: deletion and same-ID reinsertion must not reset authority.
CREATE FUNCTION inbox_reply_context.bump(ns text,old_org uuid,old_id uuid,new_org uuid,new_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target record;
BEGIN
 IF ns IS NULL OR ns NOT IN ('sender_inventory','organization_name','property_market') THEN RAISE EXCEPTION 'Invalid reply context namespace'; END IF;
 FOR target IN SELECT DISTINCT org,id FROM (VALUES(old_org,old_id),(new_org,new_id)) v(org,id) WHERE org IS NOT NULL AND id IS NOT NULL ORDER BY org,id LOOP
  INSERT INTO inbox_reply_context.versions VALUES(target.org,ns,target.id,1)
  ON CONFLICT(org_id,namespace,target_id) DO UPDATE SET revision=inbox_reply_context.versions.revision+1;
 END LOOP;
END $$;
CREATE FUNCTION inbox_reply_context.capture_sender() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_org uuid;old_id uuid;new_org uuid;new_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.provider,OLD.phone_e164,OLD.status,OLD.messaging_status,OLD.provider_number_id) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.provider,NEW.phone_e164,NEW.status,NEW.messaging_status,NEW.provider_number_id) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN old_org:=OLD.org_id;old_id:=OLD.id;END IF;
 IF TG_OP<>'DELETE' THEN new_org:=NEW.org_id;new_id:=NEW.id;END IF;
 PERFORM inbox_reply_context.bump('sender_inventory',old_org,old_id,new_org,new_id);RETURN NULL;
END $$;
CREATE FUNCTION inbox_reply_context.capture_organization() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_id uuid;new_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.name) IS NOT DISTINCT FROM (NEW.id,NEW.name) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN old_id:=OLD.id;END IF;
 IF TG_OP<>'DELETE' THEN new_id:=NEW.id;END IF;
 PERFORM inbox_reply_context.bump('organization_name',old_id,old_id,new_id,new_id);RETURN NULL;
END $$;
CREATE FUNCTION inbox_reply_context.capture_property() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_org uuid;old_id uuid;new_org uuid;new_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.market) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.market) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN old_org:=OLD.org_id;old_id:=OLD.id;END IF;
 IF TG_OP<>'DELETE' THEN new_org:=NEW.org_id;new_id:=NEW.id;END IF;
 PERFORM inbox_reply_context.bump('property_market',old_org,old_id,new_org,new_id);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzzz_inbox_reply_context AFTER INSERT OR UPDATE OR DELETE ON public.provider_sender_numbers FOR EACH ROW EXECUTE FUNCTION inbox_reply_context.capture_sender();
CREATE TRIGGER zzzzzzz_inbox_reply_context AFTER INSERT OR UPDATE OR DELETE ON public.organizations FOR EACH ROW EXECUTE FUNCTION inbox_reply_context.capture_organization();
CREATE TRIGGER zzzzzzz_inbox_reply_context AFTER INSERT OR UPDATE OR DELETE ON public.properties FOR EACH ROW EXECUTE FUNCTION inbox_reply_context.capture_property();
CREATE FUNCTION inbox_reply_context.value(o uuid,ns text,t uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF ns='sender_inventory' THEN
  SELECT jsonb_build_object('id',id,'org_id',org_id,'provider',provider,'phone_e164',phone_e164,'status',status,'messaging_status',messaging_status,'provider_number_id',provider_number_id) INTO result FROM public.provider_sender_numbers WHERE id=t AND org_id=o;
 ELSIF ns='organization_name' THEN
  SELECT jsonb_build_object('id',id,'name',name) INTO result FROM public.organizations WHERE id=t AND id=o;
 ELSIF ns='property_market' THEN
  SELECT jsonb_build_object('id',id,'org_id',org_id,'market',market) INTO result FROM public.properties WHERE id=t AND org_id=o;
 ELSE RAISE EXCEPTION 'Invalid reply context namespace'; END IF;
 RETURN result;
END $$;
CREATE FUNCTION inbox_reply_context.snapshot(o uuid,ns text,t uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE source jsonb;version bigint;
BEGIN
 -- A negative canonical read cannot allocate permanent counters for arbitrary
 -- UUIDs. Existing pre-trigger rows establish their baseline once only.
 source:=inbox_reply_context.value(o,ns,t);
 IF source IS NULL THEN RETURN NULL;END IF;
 INSERT INTO inbox_reply_context.versions VALUES(o,ns,t,1) ON CONFLICT(org_id,namespace,target_id) DO NOTHING;
 SELECT revision INTO STRICT version FROM inbox_reply_context.versions WHERE org_id=o AND namespace=ns AND target_id=t FOR UPDATE;
 -- Fresh statement after any wait. Never authorize with the preliminary read.
 source:=inbox_reply_context.value(o,ns,t);
 IF source IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('namespace',ns,'target_id',t,'revision',version::text,'value',source);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_context FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_context FROM PUBLIC,anon,authenticated,service_role;



-- Pinned reply_recipient: experiments/inbox-reply-preparation/recipient.sql
-- source_sha256=90d1e6d24f954a7ae809962c8f7181a4f9a21b973303163c9655940e4c18cdf1
-- Private canonical recipient capture. No public API or send permission.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;
END $$;
CREATE SCHEMA inbox_reply_preparation AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_reply_preparation FROM PUBLIC,anon,authenticated,service_role;
-- Exact current application normalization (csv/normalize.ts), not a new phone
-- policy. It admits ten digits, or eleven digits beginning with one.
CREATE FUNCTION inbox_reply_preparation.phone(raw text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN length(d)=10 THEN '+1'||d WHEN length(d)=11 AND left(d,1)='1' THEN '+'||d END FROM (SELECT regexp_replace(raw,'[^0-9]','','g') d) s
$$;
-- Single source of truth for the D5 bulk-reply recipient cap. batch.sql and
-- inbox_reply_review.view() (setup.sql) both call this instead of repeating
-- the literal; src/lib/inbox/reply-api-contract.ts's INBOX_REPLY_RECIPIENT_LIMIT
-- constant must stay in parity (checked by a TS test reading this source file).
CREATE FUNCTION inbox_reply_preparation.recipient_limit() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT 50
$$;
-- Single source of truth for "what is this contact's latest sms consent
-- state" — used by destination_policy()'s canonical-keyed step, its
-- slot-keyed cross-contact scan, and its strict no-consent gate. Extracted
-- (round 6), not changed: the ORDER BY / tie-break / event-type set is
-- byte-identical to what was previously inlined in three places, so no
-- caller's observable behavior differs from this extraction alone.
-- Parameter deliberately NOT named contact_id: a same-named parameter would
-- shadow-collide with the ce.contact_id column reference inside this SQL
-- function body, silently turning the WHERE clause into a tautology
-- (ce.contact_id=ce.contact_id) and returning the org's latest consent event
-- for ANY contact instead of this one — caught by mutation testing (round 6).
CREATE FUNCTION inbox_reply_preparation.latest_sms_consent(o uuid,for_contact uuid) RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT ce.event_type FROM public.consent_events ce
  WHERE ce.org_id=o AND ce.contact_id=for_contact AND ce.channel='sms'
    AND ce.event_type IN ('opt_in_marketing_written','opt_in_confirmed','opt_in_informational','opt_out','provider_auto_opt_out')
  ORDER BY ce.occurred_at DESC,(ce.event_type IN ('opt_out','provider_auto_opt_out')) DESC,ce.id DESC LIMIT 1
$$;
-- E1-E4 (Fable round 4): the SOLE eligibility authority for the reply lane.
-- Previously, eligibility was re-derived ad hoc inside recipient() from just
-- the canonical (conversation's) contact row, which is how three separate
-- fail-open holes reached this file across rounds 1-3: a first-slot-only
-- pick (round 3), and no cross-contact/global-DNC awareness at all (this
-- round). destination_policy() is now the ONE place that decides whether a
-- normalized E.164 destination is eligible, evaluated org-wide — not
-- per-contact — so a fix here closes the hole for every caller, present and
-- future, instead of being re-litigated per caller.
--
-- Evaluated in order, first hit wins (tie prefers opt-out):
--  1. sms_phone_suppressions exact match — parity with send.ts's
--     isSmsPhoneSuppressed (opt-out-phone.ts).
--  2. global_phone_dnc_registry exact match — production code in src/ never
--     reads this table for send-eligibility today; this closes that gap for
--     the reply lane specifically.
--  3. Canonical-keyed suppression (round 6): the CANONICAL contact's own
--     do_not_contact/sms_opted_out/latest-opt-out, looked up directly by id
--     — independent of whether its phone slot still normalizes to this
--     destination. Closes a reproduced fail-open: a canonical contact whose
--     slot was cleared (number edited/changed) while opted out returned
--     eligible, because step 4 below only matches contacts whose slot
--     CURRENTLY normalizes to the destination, and some other org contact
--     kept the number alive on its own slot. A canonical id that does not
--     resolve to a contact in this org (deleted, or foreign) returns the
--     fail-closed 'contact_unavailable' label here instead of falling
--     through eligible for lack of evidence.
--  4. ANY contact in the org with a phone slot normalizing to this
--     destination that is do_not_contact/sms_opted_out, or whose latest sms
--     consent event is an opt-out — closes cross-contact bleed (the same
--     number saved under a second contact record with a suppression flag
--     the canonical contact doesn't carry).
--  5. ANY matching slot across those contacts is 'landline' — hard block.
-- `strict` (default true, fail-closed) additionally requires EVERY matching
-- slot to be 'mobile' (else 'unclassified_phone') and the CANONICAL
-- contact's latest sms consent event to be an affirmative opt-in (else
-- 'no_consent'). Steps 1-5 run under both strict values; only the two extra
-- checks are strict-gated. Flipping strict to false (production parity with
-- send.ts/bulk-queue.ts) is Jarrad's call, and is a single argument change,
-- not a rewrite. Steps 3 and 4 (and the strict no-consent gate) all share
-- one latest_sms_consent(o,contact) helper so the tie-break rule cannot
-- drift between them.
--
-- PLACEMENT (E4, not built in this PR): capture/freeze (this file, PR-A)
-- calls this once per candidate and freezes the result. Acceptance (PR C/E)
-- MUST re-run this predicate live per frozen item before commit — a newly
-- surfaced exclusion there is a 409 (stale review), and the 50-cap recounts
-- after removing newly-ineligible items. The dispatch worker's claim step
-- (PR F) MUST re-run it again per item immediately before dispatch_started —
-- an exclusion there terminates that item as 'skipped_ineligible' with no
-- provider attempt, never a silent send. Neither of those call sites exists
-- yet; this is the contract they must honor when built.
CREATE FUNCTION inbox_reply_preparation.destination_policy(o uuid,destination text,canonical_contact uuid,strict boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE any_landline boolean;any_non_mobile boolean;canonical_consent text;canonical_dnc boolean;canonical_opted_out boolean;
BEGIN
 IF o IS NULL OR destination IS NULL OR canonical_contact IS NULL OR strict IS NULL THEN RAISE EXCEPTION 'Invalid destination policy input';END IF;
 -- 1. Explicit phone-level suppression (org-scoped exact E.164 match).
 IF EXISTS(SELECT 1 FROM public.sms_phone_suppressions WHERE org_id=o AND channel='sms' AND phone_e164=destination) THEN RETURN jsonb_build_object('exclusion','sms_suppressed');END IF;
 -- 2. Global DNC registry (org-scoped exact E.164 match) — never checked by
 -- production send.ts/bulk-queue.ts today.
 IF EXISTS(SELECT 1 FROM public.global_phone_dnc_registry WHERE org_id=o AND phone_e164=destination) THEN RETURN jsonb_build_object('exclusion','sms_suppressed');END IF;
 -- 3. Canonical-keyed suppression (round 6): the canonical contact's OWN
 -- do_not_contact/sms_opted_out/latest opt-out, checked directly by id —
 -- independent of whether its slot still normalizes to `destination`. Closes
 -- the fail-open where step 4 below only matches contacts whose slot
 -- CURRENTLY matches, so a cleared-slot opted-out canonical fell through as
 -- eligible whenever some other org contact still saved the number.
 SELECT ct.do_not_contact,ct.sms_opted_out INTO canonical_dnc,canonical_opted_out FROM public.contacts ct WHERE ct.id=canonical_contact AND ct.org_id=o;
 IF NOT FOUND THEN RETURN jsonb_build_object('exclusion','contact_unavailable');END IF;
 IF canonical_dnc IS TRUE OR canonical_opted_out IS TRUE OR inbox_reply_preparation.latest_sms_consent(o,canonical_contact) IN ('opt_out','provider_auto_opt_out') THEN RETURN jsonb_build_object('exclusion','sms_suppressed');END IF;
 -- 4. Cross-contact bleed: ANY org contact sharing this destination across
 -- any of its saved slots, flagged suppressed or opted out — not just the
 -- canonical contact for this conversation.
 IF EXISTS(
   SELECT 1 FROM public.contacts ct WHERE ct.org_id=o
   AND EXISTS(SELECT 1 FROM (VALUES(ct.phone_1),(ct.phone_2),(ct.phone_3)) slots(phone) WHERE inbox_reply_preparation.phone(phone)=destination)
   AND (
     ct.do_not_contact IS TRUE OR ct.sms_opted_out IS TRUE
     OR inbox_reply_preparation.latest_sms_consent(o,ct.id) IN ('opt_out','provider_auto_opt_out')
   )
 ) THEN RETURN jsonb_build_object('exclusion','sms_suppressed');END IF;
 -- 5. Landline across every matching slot on every matching org contact.
 SELECT bool_or(t='landline'),bool_or(t IS DISTINCT FROM 'mobile') INTO any_landline,any_non_mobile
 FROM public.contacts ct,LATERAL (VALUES(ct.phone_1,ct.phone_1_type),(ct.phone_2,ct.phone_2_type),(ct.phone_3,ct.phone_3_type)) slots(phone,t)
 WHERE ct.org_id=o AND inbox_reply_preparation.phone(slots.phone)=destination;
 IF any_landline THEN RETURN jsonb_build_object('exclusion','landline');END IF;
 IF strict THEN
  -- coalesce: bool_or over an empty matching slot-set is NULL, not false. A
  -- destination no contact in the org has ever saved as mobile (including
  -- one cleared/deleted between capture and accept) must fail closed here,
  -- not fall through as eligible for lack of evidence either way — strict
  -- means "affirmatively saved mobile", never "no evidence" (Fable ruling).
  IF coalesce(any_non_mobile,true) THEN RETURN jsonb_build_object('exclusion','unclassified_phone');END IF;
  canonical_consent:=inbox_reply_preparation.latest_sms_consent(o,canonical_contact);
  IF canonical_consent IS DISTINCT FROM 'opt_in_marketing_written' AND canonical_consent IS DISTINCT FROM 'opt_in_confirmed' AND canonical_consent IS DISTINCT FROM 'opt_in_informational' THEN RETURN jsonb_build_object('exclusion','no_consent');END IF;
 END IF;
 RETURN jsonb_build_object('exclusion',NULL);
END $$;
CREATE FUNCTION inbox_reply_preparation.recipient(o uuid,c uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE initial jsonb;resolved jsonb;p public.properties;contact public.contacts;inbound public.messages;head public.inbox_inbound_heads;
 target_revision bigint;content_revision bigint;capture_generation uuid;destination text;business text;destination_result jsonb;sender uuid;inventory jsonb;organization jsonb;market jsonb;requirements jsonb;policy jsonb;
BEGIN
 IF o IS NULL OR c IS NULL THEN RAISE EXCEPTION 'Invalid recipient identity';END IF;
 initial:=inbox_summary_contract.compute(o,c,clock_timestamp());
 IF initial->>'exists' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('exclusion','conversation_unavailable');END IF;
 -- Canonical source locks precede version locks. The outer preparation orders
 -- conversations deterministically and retries whole aborted transactions.
 SELECT * INTO p FROM public.properties WHERE org_id=o AND id=(initial->>'property_id')::uuid FOR SHARE;
 IF NOT FOUND OR p.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('exclusion','property_unavailable');END IF;
 IF p.is_training IS TRUE OR p.is_dnc_locked IS TRUE OR p.outreach_dispo IN ('wrong_number','bad_number','dnc','opted_out') THEN RETURN jsonb_build_object('exclusion','property_suppressed');END IF;
 SELECT * INTO contact FROM public.contacts WHERE org_id=o AND id=(initial->>'contact_id')::uuid FOR SHARE;
 IF NOT FOUND OR contact.id IS DISTINCT FROM p.homeowner_contact_id THEN RETURN jsonb_build_object('exclusion','contact_mapping_unavailable');END IF;
 IF contact.do_not_contact IS TRUE OR contact.sms_opted_out IS TRUE THEN RETURN jsonb_build_object('exclusion','contact_suppressed');END IF;
 -- Historical baseline only after an actual canonical inbound exists. Do not
 -- allocate immortal heads/version rows for caller-generated nonexistent IDs.
 IF NOT EXISTS(SELECT 1 FROM public.messages WHERE org_id=o AND conversation_id=c AND channel='sms' AND direction='inbound' AND status NOT IN ('queued','paused')) THEN RETURN jsonb_build_object('exclusion','inbound_unavailable');END IF;
 SELECT generation INTO STRICT capture_generation FROM inbox_capture_boundary.generation WHERE singleton IS TRUE FOR SHARE;
 INSERT INTO public.inbox_inbound_heads(org_id,conversation_id,revision) VALUES(o,c,1) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT head FROM public.inbox_inbound_heads WHERE org_id=o AND conversation_id=c FOR UPDATE;
 INSERT INTO inbox_message_capture.versions VALUES(o,'known_reply',c,1) ON CONFLICT DO NOTHING;
 SELECT revision INTO STRICT content_revision FROM inbox_message_capture.versions WHERE org_id=o AND namespace='known_reply' AND target_id=c FOR UPDATE;
 INSERT INTO inbox_operation_domain.target_versions VALUES(o,c,1) ON CONFLICT DO NOTHING;
 SELECT revision INTO STRICT target_revision FROM inbox_operation_domain.target_versions WHERE org_id=o AND conversation_id=c FOR UPDATE;
 resolved:=inbox_summary_contract.compute(o,c,clock_timestamp());
 IF resolved->>'exists' IS DISTINCT FROM 'true' OR resolved->>'property_id' IS DISTINCT FROM p.id::text OR resolved->>'contact_id' IS DISTINCT FROM contact.id::text THEN RETURN jsonb_build_object('exclusion','conversation_changed');END IF;
 SELECT * INTO inbound FROM public.messages WHERE org_id=o AND conversation_id=c AND channel='sms' AND direction='inbound' AND status NOT IN ('queued','paused') ORDER BY created_at DESC,id DESC LIMIT 1;
 IF NOT FOUND OR inbound.property_id IS DISTINCT FROM p.id OR inbound.contact_id IS DISTINCT FROM contact.id THEN RETURN jsonb_build_object('exclusion','inbound_mapping_changed');END IF;
 destination:=inbox_reply_preparation.phone(inbound.from_address);
 business:=inbox_reply_preparation.phone(inbound.to_address);
 IF destination IS NULL OR business IS NULL THEN RETURN jsonb_build_object('exclusion','reply_route_unavailable');END IF;
 -- Conversation identity only: does THIS contact (the one tied to this
 -- specific conversation) have the reply destination saved at all? This is
 -- NOT eligibility policy — destination_policy() below is the sole
 -- authority for whether the destination itself is textable, evaluated
 -- org-wide, not per-contact.
 IF NOT EXISTS(SELECT 1 FROM (VALUES(contact.phone_1),(contact.phone_2),(contact.phone_3)) slots(phone) WHERE inbox_reply_preparation.phone(phone)=destination) THEN RETURN jsonb_build_object('exclusion','phone_not_saved');END IF;
 requirements:=jsonb_build_array(
  jsonb_build_object('namespace','property_identity','key',jsonb_build_array(p.id)),jsonb_build_object('namespace','property_policy','key',jsonb_build_array(p.id)),
  jsonb_build_object('namespace','property_outcome','key',jsonb_build_array(p.id)),jsonb_build_object('namespace','property_reply_content','key',jsonb_build_array(p.id)),
  jsonb_build_object('namespace','contact_identity','key',jsonb_build_array(contact.id)),jsonb_build_object('namespace','contact_policy','key',jsonb_build_array(contact.id)),
  jsonb_build_object('namespace','contact_reply_content','key',jsonb_build_array(contact.id)),jsonb_build_object('namespace','contact_channel_consent','key',jsonb_build_array(contact.id,'sms')),
  jsonb_build_object('namespace','route_policy','key',jsonb_build_array('sms',destination)),jsonb_build_object('namespace','conversation_identity','key',jsonb_build_array(c)));
 policy:=inbox_action_api.policy(o,requirements);
 -- Single eligibility authority (E1-E4, round 4). strict=true is the
 -- current fail-closed default; see destination_policy()'s own header for
 -- what each of its 4 org-wide steps plus the 2 strict-only checks cover.
 destination_result:=inbox_reply_preparation.destination_policy(o,destination,contact.id,true);
 IF destination_result->>'exclusion' IS NOT NULL THEN RETURN destination_result;END IF;
 SELECT id INTO sender FROM public.provider_sender_numbers WHERE org_id=o AND provider='sendillo' AND phone_e164=business;
 IF NOT FOUND THEN RETURN jsonb_build_object('exclusion','sender_unavailable');END IF;
 inventory:=inbox_reply_context.snapshot(o,'sender_inventory',sender);
 IF inventory IS NULL OR inventory->'value'->>'status'<>'active' OR inventory->'value'->>'provider' IS DISTINCT FROM 'sendillo' OR inventory->'value'->>'phone_e164' IS DISTINCT FROM business THEN RETURN jsonb_build_object('exclusion','sender_unavailable');END IF;
 organization:=inbox_reply_context.snapshot(o,'organization_name',o);
 market:=inbox_reply_context.snapshot(o,'property_market',p.id);
 IF organization IS NULL OR market IS NULL THEN RETURN jsonb_build_object('exclusion','context_unavailable');END IF;
 IF (resolved->>'next_window_expiry')::timestamptz<=clock_timestamp() THEN RETURN jsonb_build_object('exclusion','conversation_window_expired');END IF;
 RETURN jsonb_build_object('exclusion',NULL,'conversation_id',c,'property_id',p.id,'contact_id',contact.id,'from',business,'to',destination,'state',p.state,
  'inbound_id',inbound.id,'inbound_created_at',inbound.created_at,'valid_until',resolved->'next_window_expiry',
  'variables',jsonb_build_object('first_name',contact.first_name,'last_name',contact.last_name,'property_address',p.address,'city',p.city,'state',p.state,'property_zip',p.zip,'market',market->'value'->'market','company_name',organization->'value'->'name'),
  'dependencies',jsonb_build_object('head',head.revision::text,'generation',capture_generation,'known_reply',content_revision::text,'target',target_revision::text,'policy',policy,'sender',inventory,'organization',organization,'market',market));
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_preparation FROM PUBLIC,anon,authenticated,service_role;



-- Pinned reply_batch: experiments/inbox-reply-preparation/batch.sql
-- source_sha256=858f72acad3bc6dc26c8560cf4e5f13dac2f5222d89539e43d416c24342c4ce2
-- Private batch capture and current application quiet-hours policy.
-- Source map SHA256: 7a7780a583099c0bf302589e23e35595de4f133ee4606fd3dfd52869d306f340

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;
END $$;
CREATE FUNCTION inbox_reply_preparation.quiet_hours(state text,at_time timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN zone IS NULL OR at_time IS NULL THEN jsonb_build_object('ok',false,'reason','unknown_state')
 ELSE jsonb_build_object('ok',extract(hour FROM timezone(zone,at_time))>=8 AND extract(hour FROM timezone(zone,at_time))<21,'zone',zone,'local_time',to_char(timezone(zone,at_time),'HH24:MI:SS')) END
 FROM (SELECT (SELECT z FROM (VALUES
 ('MO','America/Chicago'),
 ('OH','America/New_York'),
 ('AL','America/Chicago'),
 ('AK','America/Anchorage'),
 ('AZ','America/Phoenix'),
 ('AR','America/Chicago'),
 ('CA','America/Los_Angeles'),
 ('CO','America/Denver'),
 ('CT','America/New_York'),
 ('DE','America/New_York'),
 ('DC','America/New_York'),
 ('FL','America/New_York'),
 ('GA','America/New_York'),
 ('HI','Pacific/Honolulu'),
 ('ID','America/Boise'),
 ('IL','America/Chicago'),
 ('IN','America/Indianapolis'),
 ('IA','America/Chicago'),
 ('KS','America/Chicago'),
 ('KY','America/New_York'),
 ('LA','America/Chicago'),
 ('ME','America/New_York'),
 ('MD','America/New_York'),
 ('MA','America/New_York'),
 ('MI','America/Detroit'),
 ('MN','America/Chicago'),
 ('MS','America/Chicago'),
 ('MT','America/Denver'),
 ('NE','America/Chicago'),
 ('NV','America/Los_Angeles'),
 ('NH','America/New_York'),
 ('NJ','America/New_York'),
 ('NM','America/Denver'),
 ('NY','America/New_York'),
 ('NC','America/New_York'),
 ('ND','America/Chicago'),
 ('OK','America/Chicago'),
 ('OR','America/Los_Angeles'),
 ('PA','America/New_York'),
 ('RI','America/New_York'),
 ('SC','America/New_York'),
 ('SD','America/Chicago'),
 ('TN','America/Chicago'),
 ('TX','America/Chicago'),
 ('UT','America/Denver'),
 ('VT','America/New_York'),
 ('VA','America/New_York'),
 ('WA','America/Los_Angeles'),
 ('WV','America/New_York'),
 ('WI','America/Chicago'),
 ('WY','America/Denver'),
 ('AS','Pacific/Pago_Pago'),
 ('GU','Pacific/Guam'),
 ('MP','Pacific/Saipan'),
 ('PR','America/Puerto_Rico'),
 ('VI','America/St_Thomas')
 ) zones(s,z) WHERE s=upper(btrim(state))) zone) q
$$;
-- No caller-controlled clock on this boundary. The pure policy helper above is
-- private and allows deterministic DST/window tests; every capture uses DB time.
CREATE FUNCTION inbox_reply_preparation.batch(o uuid,ids uuid[]) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE c uuid;item jsonb;items jsonb:='[]';eligible integer;duplicates text[];
BEGIN
 IF o IS NULL OR ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 500 OR array_ndims(ids) IS DISTINCT FROM 1 OR EXISTS(SELECT 1 FROM unnest(ids) id WHERE id IS NULL) OR (SELECT count(DISTINCT id) FROM unnest(ids) id)<>cardinality(ids) THEN RAISE EXCEPTION 'Invalid bounded reply targets';END IF;
 FOR c IN SELECT id FROM unnest(ids) id ORDER BY id LOOP
  item:=inbox_reply_preparation.recipient(o,c)||jsonb_build_object('conversation_id',c);
  IF item->>'exclusion' IS NULL THEN item:=item||jsonb_build_object('quiet_hours',inbox_reply_preparation.quiet_hours(item->>'state',clock_timestamp()));END IF;
  items:=items||jsonb_build_array(item);
 END LOOP;
 -- Earlier recipients may expire while later source locks are awaited.
 SELECT jsonb_agg(CASE WHEN value->>'exclusion' IS NULL AND (value->>'valid_until')::timestamptz<=clock_timestamp() THEN value||jsonb_build_object('exclusion','conversation_window_expired') ELSE value END ORDER BY value->>'conversation_id') INTO items FROM jsonb_array_elements(items);
 -- A shared destination is a visible conflict on EVERY affected conversation;
 -- never silently choose the first conversation or issue multiple sends.
 SELECT array_agg(destination) INTO duplicates FROM (SELECT value->>'to' destination FROM jsonb_array_elements(items) WHERE value->>'exclusion' IS NULL GROUP BY value->>'to' HAVING count(*)>1) q;
 SELECT jsonb_agg(value||jsonb_build_object('duplicate_destination',coalesce((value->>'to')=ANY(duplicates),false)) ORDER BY value->>'conversation_id') INTO items FROM jsonb_array_elements(items);
 SELECT count(DISTINCT value->>'to') INTO eligible FROM jsonb_array_elements(items) WHERE value->>'exclusion' IS NULL;
 RETURN jsonb_build_object('items',items,'distinct_recipient_count',eligible,'over_recipient_limit',eligible>inbox_reply_preparation.recipient_limit(),'has_duplicate_destinations',coalesce(cardinality(duplicates)>0,false));
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_preparation FROM PUBLIC,anon,authenticated,service_role;



-- Pinned reply_review_setup: experiments/inbox-reply-review/setup.sql
-- source_sha256=86f5ef25c7f0e753d847d7e75567795d1a3e596023955d886bfdbc817e790b57
-- Owned candidate: authenticated capture and immutable reviewed literal bodies.
-- The application renders templates between capture and freeze. Rendered bodies
-- are user-authored message intent; routes and eligibility are always canonical.
--
-- P-GATE (HARD, binds accept/claim in PR-E and every later lane):
--  1. freeze() stores draft->>'body' and draft->>'exclusion' VERBATIM. Both are
--     operator-authored and reachable by direct RPC. Neither is a safety input.
--  2. No content rule (identification/opt-out footer, approved-templates-only,
--     banned content) may be enforced only in the TS renderer. If one exists it
--     MUST be enforced from the frozen row at accept AND claim, in SQL/worker.
--  3. Until such a rule exists the frozen body is sent verbatim, never
--     re-rendered, never re-parsed as template syntax.
--  4. A frozen exclusion is send-SUPPRESSION only: exclusion IS NOT NULL is
--     terminal (no send, no revival). exclusion IS NULL is a precondition, never
--     an authorization: accept/claim re-run destination_policy, deps, expiry,
--     and recipient_limit() from canonical state (E4/D1/D5).

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;
END $$;
CREATE SCHEMA inbox_reply_review AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_reply_review FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_reply_review.preparations(
 id uuid PRIMARY KEY,org_id uuid NOT NULL,requester_id uuid NOT NULL,request_key uuid NOT NULL,
 input_hash text NOT NULL,canonical_input text NOT NULL,items jsonb NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,requester_id,request_key)
);
-- immutable_row only guarantees immutability against ordinary DML from a
-- non-superuser role. It does not defend against TRUNCATE (no per-row
-- trigger fires), SET session_replication_role='replica' (suppresses
-- non-replica triggers), or ALTER TABLE ... DISABLE TRIGGER — all three
-- require superuser or table-owner privilege, which authenticated/
-- service_role never hold here (REVOKE ALL below), so the app-facing
-- boundary holds even though the guarantee is not absolute against the
-- table owner itself.
CREATE TRIGGER immutable_reply_preparation BEFORE UPDATE OR DELETE ON inbox_reply_review.preparations FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();
-- JS message length is UTF-16 code units, not PostgreSQL Unicode characters.
CREATE FUNCTION inbox_reply_review.text_length(body text) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT length(body)+(SELECT count(*)::integer FROM regexp_split_to_table(body,'') c WHERE ascii(c)>65535)
$$;
CREATE FUNCTION inbox_reply_review.capture(ids uuid[]) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE a jsonb;result jsonb;
BEGIN
 a:=inbox_action_api.authorize(NULL);
 result:=inbox_reply_preparation.batch((a->>'org_id')::uuid,ids);
 PERFORM inbox_action_api.authorize((a->>'org_id')::uuid,(a->>'user_id')::uuid);
 RETURN result;
END $$;
CREATE FUNCTION inbox_reply_review.view(p inbox_reply_review.preparations) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 WITH eligible AS (SELECT value FROM jsonb_array_elements(p.items) WHERE value->>'exclusion' IS NULL),
 counts AS (SELECT count(DISTINCT value->'recipient'->>'to')::integer n,coalesce(bool_or((value->>'duplicateDestination')::boolean),false) duplicates FROM eligible)
 SELECT jsonb_build_object('preparationId',p.id,'idempotencyKey',p.request_key,'inputHash',p.input_hash,'expiresAt',p.expires_at,
  'items',(SELECT jsonb_agg(value-'dependencies'-'validUntil'-'state' ORDER BY value->'target'->>'id') FROM jsonb_array_elements(p.items)),
  'recipientCount',n,'blockers',to_jsonb(array_remove(ARRAY[CASE WHEN n=0 THEN 'empty' END,CASE WHEN n>inbox_reply_preparation.recipient_limit() THEN 'recipient_limit' END,CASE WHEN duplicates THEN 'duplicate_destination' END],NULL))) FROM counts
$$;
CREATE FUNCTION inbox_reply_review.freeze(raw_input text,k uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE a jsonb;o uuid;u uuid;input jsonb;target jsonb;draft jsonb;capture jsonb;item jsonb;items jsonb:='[]';ids uuid[];captures jsonb;found_count integer;reason text;duplicates text[];hash text;existing inbox_reply_review.preparations;prep inbox_reply_review.preparations;expires timestamptz;at_time timestamptz;
BEGIN
 IF k IS NULL OR raw_input IS NULL OR octet_length(raw_input)>2097152 THEN RAISE EXCEPTION 'Invalid bounded reply preparation';END IF;
 PERFORM inbox_action_api.assert_json_shape(raw_input::json);input:=raw_input::jsonb;
 IF jsonb_typeof(input) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(input))<>3 OR NOT(input ?& ARRAY['targets','drafts','template']) OR jsonb_typeof(input->'targets') IS DISTINCT FROM 'array' OR jsonb_array_length(input->'targets') NOT BETWEEN 1 AND 500 OR jsonb_typeof(input->'drafts') IS DISTINCT FROM 'array' OR jsonb_array_length(input->'drafts')>500 OR jsonb_typeof(input->'template') IS DISTINCT FROM 'string' OR btrim(input->>'template')='' OR inbox_reply_review.text_length(input->>'template')>1600 THEN RAISE EXCEPTION 'Invalid reply envelope';END IF;
 a:=inbox_action_api.authorize(NULL);o:=(a->>'org_id')::uuid;u:=(a->>'user_id')::uuid;
 PERFORM inbox_action_api.lock_request_key(o,u,k);
 -- Idempotency keys on CLIENT INTENT — which targets, what raw template text
 -- the operator typed — not on the server-rendered per-recipient body/
 -- dependencies snapshot in 'drafts' below. Those legitimately drift between
 -- attempts (a new inbound bumps the head revision, a policy/sender/context/
 -- contact-name revision changes) without the user having asked for anything
 -- different. A same-key replay compares ONLY this intent hash; dependency
 -- drift against the frozen snapshot is the accept/claim recheck's job, never
 -- freeze replay's. Targets are sorted before hashing so request-order alone
 -- never produces a spurious mismatch.
 -- Component-hash-then-concatenate (not string-join-then-hash): a text value
 -- can never contain chr(0), so any single fixed separator risks collision
 -- between a crafted targets/template split and a different one. Hashing
 -- each component to a fixed-width digest before combining removes that
 -- ambiguity entirely.
 -- Targets are normalized through ::uuid::text (not hashed as raw client
 -- text) before hashing: the uuid type parses case- and (within reason)
 -- format-insensitively, so two requests naming the identical target with
 -- different letter-case in its id string must hash identically, not be
 -- treated as a different intent.
 hash:=encode(sha256(convert_to('sandra:inbox:reply:intent:v1','utf8')||sha256(convert_to((SELECT coalesce(jsonb_agg(jsonb_build_object('kind',value->>'kind','id',(value->>'id')::uuid::text) ORDER BY value->>'kind',(value->>'id')::uuid::text),'[]'::jsonb) FROM jsonb_array_elements(input->'targets'))::text,'utf8'))||sha256(convert_to(input->>'template','utf8'))),'hex');
 SELECT * INTO existing FROM inbox_reply_review.preparations WHERE org_id=o AND requester_id=u AND request_key=k;
 IF FOUND THEN
  IF existing.input_hash<>hash THEN RAISE EXCEPTION 'INBOX_REPLY_IDEMPOTENCY_MISMATCH';END IF;
  PERFORM inbox_action_api.authorize(o,u);
  -- B2: mark this a replay so the coordinator never compares the immutable
  -- frozen items against a fresh render of a possibly-drifted dependency.
  RETURN inbox_reply_review.view(existing)||jsonb_build_object('replayed',true);
 END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(input->'targets') LOOP
  IF jsonb_typeof(target) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(target))<>2 OR NOT(target ?& ARRAY['kind','id']) OR target->>'kind' NOT IN ('conversation','unknown_sender_group') OR target->>'kind' IS NULL OR target->>'id' IS NULL THEN RAISE EXCEPTION 'Invalid reply target';END IF;
  PERFORM (target->>'id')::uuid;
 END LOOP;
 IF (SELECT count(DISTINCT (value->>'kind')||':'||((value->>'id')::uuid)::text) FROM jsonb_array_elements(input->'targets'))<>jsonb_array_length(input->'targets') THEN RAISE EXCEPTION 'Duplicate reply target';END IF;
 FOR draft IN SELECT value FROM jsonb_array_elements(input->'drafts') LOOP
  IF jsonb_typeof(draft) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(draft))<>4 OR NOT(draft ?& ARRAY['conversationId','body','dependencies','exclusion']) OR draft->>'conversationId' IS NULL OR jsonb_typeof(draft->'dependencies') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid reply draft';END IF;
  PERFORM (draft->>'conversationId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'targets') t WHERE t->>'kind'='conversation' AND (t->>'id')::uuid=(draft->>'conversationId')::uuid) THEN RAISE EXCEPTION 'Unexpected reply draft';END IF;
  IF draft->'exclusion'='null'::jsonb THEN
   IF jsonb_typeof(draft->'body') IS DISTINCT FROM 'string' OR btrim(draft->>'body',chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))='' OR inbox_reply_review.text_length(draft->>'body')>1600 THEN RAISE EXCEPTION 'Invalid reply body';END IF;
  ELSIF draft->>'exclusion' NOT IN ('missing_variable','invalid_template','invalid_body') OR draft->'body' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Invalid reply rendering exclusion';END IF;
 END LOOP;
 IF (SELECT count(DISTINCT (value->>'conversationId')::uuid) FROM jsonb_array_elements(input->'drafts'))<>jsonb_array_length(input->'drafts') THEN RAISE EXCEPTION 'Duplicate reply draft';END IF;
 SELECT array_agg((value->>'id')::uuid ORDER BY (value->>'id')::uuid) INTO ids FROM jsonb_array_elements(input->'targets') WHERE value->>'kind'='conversation';
 captures:=CASE WHEN cardinality(ids)>0 THEN inbox_reply_preparation.batch(o,ids)->'items' ELSE '[]'::jsonb END;
 FOR target IN SELECT value FROM jsonb_array_elements(input->'targets') ORDER BY value->>'kind',value->>'id' LOOP
  reason:=NULL;capture:=NULL;draft:=NULL;
  IF target->>'kind'<>'conversation' THEN reason:='unsupported_target';
  ELSE
   SELECT value INTO capture FROM jsonb_array_elements(captures) WHERE (value->>'conversation_id')::uuid=(target->>'id')::uuid;
   reason:=capture->>'exclusion';
   IF capture IS NULL THEN RAISE EXCEPTION 'Missing canonical reply capture';END IF;
   IF reason IS NULL THEN
    SELECT value INTO draft FROM jsonb_array_elements(input->'drafts') WHERE (value->>'conversationId')::uuid=(target->>'id')::uuid;
    IF draft IS NULL OR draft->'dependencies' IS DISTINCT FROM capture->'dependencies' THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_CHANGED';END IF;
--     Client-chosen rendering exclusion: subtractive only; see P-GATE header.
    reason:=draft->>'exclusion';
   END IF;
  END IF;
  item:=jsonb_build_object('id',gen_random_uuid(),'target',jsonb_build_object('kind',target->>'kind','id',(target->>'id')::uuid),'exclusion',reason,'recipient',CASE WHEN reason IS NULL THEN jsonb_build_object('contactName',coalesce(nullif(btrim(concat_ws(' ',capture->'variables'->>'first_name',capture->'variables'->>'last_name')),''),capture->>'to'),'propertyAddress',coalesce(capture->'variables'->>'property_address',''),'propertyId',capture->'property_id','contactId',capture->'contact_id','from',capture->'from','to',capture->'to','renderedBody',draft->>'body') END,'dependencies',capture->'dependencies','validUntil',capture->'valid_until','state',capture->'state','duplicateDestination',false);
  items:=items||jsonb_build_array(item);
 END LOOP;
 -- No client clock. Re-evaluate all time-only boundaries after all lock waits.
 at_time:=clock_timestamp();expires:=at_time+interval '5 minutes';
 SELECT jsonb_agg(CASE WHEN value->>'exclusion' IS NOT NULL THEN value
  WHEN (value->>'validUntil')::timestamptz<=at_time THEN value||jsonb_build_object('exclusion','conversation_window_expired','recipient',NULL)
  WHEN inbox_reply_preparation.quiet_hours(value->>'state',at_time)->>'ok'<>'true' THEN value||jsonb_build_object('exclusion',CASE WHEN inbox_reply_preparation.quiet_hours(value->>'state',at_time)->>'reason'='unknown_state' THEN 'unknown_state' ELSE 'outside_window' END,'recipient',NULL)
  ELSE value END ORDER BY value->'target'->>'id') INTO items FROM jsonb_array_elements(items);
 SELECT array_agg(destination) INTO duplicates FROM (SELECT value->'recipient'->>'to' destination FROM jsonb_array_elements(items) WHERE value->>'exclusion' IS NULL GROUP BY value->'recipient'->>'to' HAVING count(*)>1) q;
 SELECT jsonb_agg(value||jsonb_build_object('duplicateDestination',coalesce((value->'recipient'->>'to')=ANY(duplicates),false)) ORDER BY value->'target'->>'id') INTO items FROM jsonb_array_elements(items);
 SELECT least(expires,min((value->>'validUntil')::timestamptz)) INTO expires FROM jsonb_array_elements(items) WHERE value->>'exclusion' IS NULL;
 PERFORM inbox_action_api.authorize(o,u);
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_EXPIRED';END IF;
 -- canonical_input retains the full first-successful raw_input (targets +
 -- drafts + template) for audit/debugging only; it is never read by the
 -- replay gate above, which compares input_hash (client intent) alone.
 INSERT INTO inbox_reply_review.preparations(id,org_id,requester_id,request_key,input_hash,canonical_input,items,expires_at) VALUES(gen_random_uuid(),o,u,k,hash,raw_input,items,expires) RETURNING * INTO prep;
 RETURN inbox_reply_review.view(prep)||jsonb_build_object('replayed',false);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_review FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_review FROM PUBLIC,anon,authenticated,service_role;



-- Pinned reply_source_operation: experiments/inbox-reply-review/source-operation.sql
-- source_sha256=769d1ebed24f1a301926955a43c77d8e4b95c46f3a8c9c2c288befdbd39e0f50
-- Metadata-operation follow-up context. This function is deliberately limited
-- to loading the accepted operation's immutable reply intent and original
-- target selection. The application then runs the normal reply capture,
-- renderer (including conditionals and OUTBOUND_SENDER_NAME), and freeze path.
-- No SQL-side template renderer or client-provided snapshot is trusted here.


CREATE FUNCTION inbox_reply_review.source_context(source_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  auth jsonb;
  org uuid;
  requester uuid;
  definition jsonb;
  final_step jsonb;
  targets jsonb;
BEGIN
  IF source_operation_id IS NULL THEN
    RAISE EXCEPTION 'INBOX_REPLY_FOLLOW_UP_UNAVAILABLE' USING ERRCODE='P0001';
  END IF;
  auth:=inbox_action_api.authorize(NULL);
  org:=(auth->>'org_id')::uuid;
  requester:=(auth->>'user_id')::uuid;
  SELECT operation.definition INTO definition
    FROM inbox_operations.operations operation
   WHERE operation.org_id=org
     AND operation.id=source_operation_id
     AND operation.requester_id=requester;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INBOX_REPLY_OPERATION_UNAVAILABLE' USING ERRCODE='42501';
  END IF;
  IF EXISTS(
    SELECT 1 FROM inbox_operations.steps step
     WHERE step.org_id=org
       AND step.operation_id=source_operation_id
       AND step.state IN ('pending','running')
  ) THEN
    RAISE EXCEPTION 'INBOX_ACTION_NOT_TERMINAL' USING ERRCODE='P0001';
  END IF;
  SELECT value INTO final_step
    FROM jsonb_array_elements(definition->'steps') WITH ORDINALITY step(value,position)
   WHERE value->>'type'='review_reply'
   ORDER BY position DESC LIMIT 1;
  IF jsonb_typeof(definition->'steps') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INBOX_REPLY_FOLLOW_UP_UNAVAILABLE' USING ERRCODE='P0001';
  END IF;
  IF jsonb_array_length(definition->'steps')=0
     OR (definition->'steps'->-1)->>'type' IS DISTINCT FROM 'review_reply'
     OR final_step IS NULL OR jsonb_typeof(final_step->'text') IS DISTINCT FROM 'string'
     OR btrim(final_step->>'text')='' THEN
    RAISE EXCEPTION 'INBOX_REPLY_FOLLOW_UP_UNAVAILABLE' USING ERRCODE='P0001';
  END IF;
  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object('kind',item.target_kind,'id',item.target_id)
             ORDER BY item.target_kind,item.target_id
           ), '[]'::jsonb
         ) INTO targets
    FROM inbox_operations.items item
   WHERE item.org_id=org AND item.operation_id=source_operation_id;
  IF jsonb_array_length(targets) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'INBOX_REPLY_FOLLOW_UP_UNAVAILABLE' USING ERRCODE='P0001';
  END IF;
  RETURN jsonb_build_object(
    'sourceOperationId',source_operation_id,
    'targets',targets,
    'template',btrim(final_step->>'text')
  );
END $$;

REVOKE ALL ON FUNCTION inbox_reply_review.source_context(uuid)
  FROM PUBLIC,anon,authenticated,service_role;



-- Pinned reply_review_public_api: experiments/inbox-reply-review/public-api.sql
-- source_sha256=0711295976fce7ff258f4948a08ed71e49374ccd1a5759034c230c505e3cb263
-- Owned candidate only: explicit default-closed RPC admission. No send endpoint.

DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;
END $$;
CREATE TABLE inbox_reply_review.admission(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),enabled boolean NOT NULL DEFAULT false);
INSERT INTO inbox_reply_review.admission(singleton) VALUES(true);
ALTER TABLE inbox_reply_review.admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_reply_review.preparations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_reply_review.admission FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_reply_review.require_admission() RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE admitted boolean;
BEGIN
 SELECT enabled INTO admitted FROM inbox_reply_review.admission WHERE singleton FOR SHARE;
 IF admitted IS DISTINCT FROM true THEN RAISE EXCEPTION 'INBOX_REPLIES_NOT_ENABLED' USING ERRCODE='55000';END IF;
END $$;
-- SECURITY DEFINER wrappers run as postgres regardless of the calling role's
-- own session GUCs, so each bounds its own worst case explicitly rather than
-- trusting an authenticated caller's session settings: a batch of up to 500
-- targets/drafts must not be able to hold row locks indefinitely or run
-- unbounded.
CREATE FUNCTION public.inbox_capture_reply_recipients(conversation_ids uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.capture(conversation_ids);
END $$;
CREATE FUNCTION public.inbox_freeze_reply_review(canonical_input text,idempotency_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.freeze(canonical_input,idempotency_key);
END $$;
CREATE FUNCTION public.inbox_reply_source_context(source_operation_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.source_context(source_operation_id);
END $$;
REVOKE ALL ON FUNCTION inbox_reply_review.require_admission() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_capture_reply_recipients(uuid[]),public.inbox_freeze_reply_review(text,uuid),public.inbox_reply_source_context(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_capture_reply_recipients(uuid[]),public.inbox_freeze_reply_review(text,uuid),public.inbox_reply_source_context(uuid) TO authenticated;



-- Pinned reply_attempts: experiments/inbox-reply-send/attempts.sql
-- source_sha256=9109db7267aad7921c4002611ede5d05f14b5bb46f182c17282d2bc4b04a63f9
-- Private durable bulk-reply send-attempt ledger (Lane 1 PR-D). No public API,
-- no route, no worker, no provider call, no send. This file ONLY records the
-- fenced state machine that PR-E (accept), PR-F (worker+dispatch) and PR-G
-- (callback) build on top of.
--
-- Fencing model (architect notes, binding):
--  - `generation` fences every mutation UP TO the claimed->dispatch_started
--    marker (claim/reclaim). Once that marker is written, `dispatch_token` is
--    the ONLY fence (persist). generation is never consulted again after the
--    marker, and no code path may reuse a generation value or re-issue a
--    dispatch_token once assigned.
--  - The BEFORE trigger enforces the transition matrix independently of every
--    function body below: even a buggy claim/start_dispatch/persist cannot
--    resurrect a terminal row or rewind a marker, because the trigger raises
--    on any UPDATE that isn't a listed edge, and DELETE always raises.
--  - Lock order: the operations row (FOR NO KEY UPDATE, via the INSERT
--    trigger's per-operation admission check) precedes any attempts row.
--    Within an attempt, the attempt row is always FOR UPDATE first; every
--    canonical read after that (sender, inbound head) is FOR SHARE only,
--    matching the prepare/worker inversion note — never FOR UPDATE on
--    heads/versions here. No path in this file, or any future PR-E/F
--    caller, may take the inbound-head row FOR UPDATE and then take a
--    write-lock on a sender row in the same transaction — that specific
--    order is the one shape that can deadlock against item_current()'s own
--    sender-then-head FOR SHARE order.
--  - THE INVARIANT (R3, binding): the last eligibility read happens after
--    the last statement that can WAIT in the transaction; the marker UPDATE
--    is the last statement that can wait, so item_current runs once MORE
--    after it returns. Nothing about a caller's business logic may run
--    between that final item_current() call and the RETURN of its result.
--  - THE ISOLATION CONTRACT (R4, binding): the R3 invariant above only holds
--    because each plpgsql statement takes a FRESH snapshot under READ
--    COMMITTED. Under REPEATABLE READ or SERIALIZABLE the whole transaction
--    shares ONE pinned snapshot, so the post-marker item_current() call would
--    see the exact same (stale) data as the pre-marker call and silently
--    miss a suppression committed during the marker's lock-wait — reverting
--    R3 without any code path looking broken. item_current() and
--    start_dispatch() both assert READ COMMITTED, as their VERY FIRST
--    statement (before any lock — start_dispatch's assert precedes its own
--    FOR UPDATE, so a REPEATABLE READ/SERIALIZABLE caller is rejected
--    immediately rather than left blocking toward a lock timeout), and raise
--    INBOX_REPLY_UNSUPPORTED_ISOLATION (0A000) otherwise. guard_attempt()'s
--    claimed->dispatch_started (marker) transition asserts the SAME thing
--    independently (R5): a caller that writes the marker via a direct
--    UPDATE, bypassing start_dispatch entirely, has no function-body assert
--    to catch it, so the trigger itself closes that hole. THIS IS A BINDING
--    CONTRACT ON PR-F: the reply worker MUST call start_dispatch() (and thus
--    item_current()) under READ COMMITTED — Postgres's default — and must
--    never raise the isolation level for that connection/transaction, in the
--    pg pool config, a Restate wrapper, or any BEGIN/SET on that path.
--  - No body/phone is ever put in an evidence string or RAISE message
--    (S11 audit trail). evidence is always a short lowercase code;
--    provider_reference is the provider's own id, never message content.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;
END $$;

-- D-12: operations header. NO status column — status is always derived from
-- attempts by callers (PR-E). Reuses the same immutable_row trigger as every
-- other operations/preparations table in this codebase.
CREATE SCHEMA inbox_reply_send AUTHORIZATION postgres;
-- Named-role (anon/authenticated/service_role) revocation is the guarded
-- absence-checking loop near the end of this file (its only mechanism —
-- these unconditional grants would otherwise duplicate and could error on a
-- fixture missing one of those roles). Only the PUBLIC revoke belongs here.
REVOKE ALL ON SCHEMA inbox_reply_send FROM PUBLIC;

-- Ships (e): additive identity anchor for inbox_reply_send.operations' FK.
-- Reply preparations were only ever looked up by (org_id,requester_id,id)
-- until now (setup.sql:26); operations here must be addressable by
-- (org_id,id) alone since the requester who prepared a reply need not be the
-- requester who accepts/claims it in later lanes. Additive only: does not
-- touch inbox_reply_review.setup.sql.
ALTER TABLE inbox_reply_review.preparations ADD CONSTRAINT preparations_org_id_key UNIQUE(org_id,id);

CREATE TABLE inbox_reply_send.operations(
 org_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),requester_id uuid NOT NULL,
 preparation_id uuid NOT NULL,idempotency_key uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,id),
 UNIQUE(org_id,preparation_id),
 UNIQUE(org_id,requester_id,idempotency_key),
 FOREIGN KEY(org_id,preparation_id) REFERENCES inbox_reply_review.preparations(org_id,id)
);
CREATE TRIGGER immutable_reply_send_operation BEFORE UPDATE OR DELETE ON inbox_reply_send.operations FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();

-- D-5/D-6: the ledger itself. One row per send attempt; item_id is the frozen
-- item's own id (inbox_reply_review preparations.items[].id, setup.sql:122),
-- NEVER inbox_operations.steps (reply lane never used steps; accepted §6
-- deviation, D-1). A NEW attempt row (never an UPDATE) is how a retry after
-- confirmed_not_submitted/rejected_unsent happens — attempt_ordinal
-- increments and prior_attempt_id chains back.
CREATE TABLE inbox_reply_send.attempts(
 org_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 operation_id uuid NOT NULL,
 preparation_id uuid NOT NULL,
 item_id uuid NOT NULL,
 attempt_ordinal integer NOT NULL CHECK(attempt_ordinal>=1),
 prior_attempt_id uuid,
 contact_id uuid NOT NULL,
 from_e164 text NOT NULL CHECK(from_e164 ~ '^\+[1-9][0-9]{1,14}$'),
 to_e164 text NOT NULL CHECK(to_e164 ~ '^\+[1-9][0-9]{1,14}$'),
 body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('approved','claimed','dispatch_started','skipped_ineligible','provider_accepted','uncertain','confirmed_not_submitted','rejected_unsent','delivered','delivery_failed')),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 lease_until timestamptz,
 dispatch_started_at timestamptz,
 dispatch_token uuid,
 receipt_version bigint NOT NULL DEFAULT 0 CHECK(receipt_version>=0),
 provider_reference text CHECK(provider_reference IS NULL OR octet_length(provider_reference)<=512),
 provider_status text CHECK(provider_status IS NULL OR octet_length(provider_status)<=128),
 evidence text CHECK(evidence IS NULL OR (octet_length(evidence)<=128 AND evidence ~ '^[a-z][a-z0-9_:]*$')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,id),
 FOREIGN KEY(org_id,operation_id) REFERENCES inbox_reply_send.operations(org_id,id),
 -- D-5 CHECKs, one per ruling clause.
 CHECK((state='claimed')=(lease_until IS NOT NULL)),
 CHECK((dispatch_started_at IS NULL)=(dispatch_token IS NULL)),
 CHECK((dispatch_started_at IS NULL)=(state IN ('approved','claimed','skipped_ineligible'))),
 CHECK((attempt_ordinal=1)=(prior_attempt_id IS NULL)),
 CHECK((state='provider_accepted' OR state IN ('delivered','delivery_failed'))=(provider_reference IS NOT NULL))
);
-- D-6(3): a prior attempt has at most one successor; composite FK back into
-- this same table so a successor's prior_attempt_id must name a real row in
-- the same org.
CREATE UNIQUE INDEX inbox_reply_send_attempt_successor ON inbox_reply_send.attempts(org_id,prior_attempt_id) WHERE prior_attempt_id IS NOT NULL;
ALTER TABLE inbox_reply_send.attempts ADD FOREIGN KEY(org_id,prior_attempt_id) REFERENCES inbox_reply_send.attempts(org_id,id);
-- D-6(1): the "live attempt" partial-unique. rejected_unsent and
-- confirmed_not_submitted are the ONLY two states that permit a successor
-- attempt for the same (preparation,item) — cond7. skipped_ineligible does
-- NOT permit a successor: its remedy is a brand new review/freeze, never a
-- retry attempt chained off it.
CREATE UNIQUE INDEX inbox_reply_send_live_attempt ON inbox_reply_send.attempts(org_id,preparation_id,item_id) WHERE state NOT IN ('rejected_unsent','confirmed_not_submitted');
-- D-6(2): ordinal is unique per (preparation,item) regardless of state.
CREATE UNIQUE INDEX inbox_reply_send_attempt_ordinal ON inbox_reply_send.attempts(org_id,preparation_id,item_id,attempt_ordinal);
-- D-6(4): D2 inter-operation destination guard, verbatim — not widened to
-- more states. Two attempts (any operation) may never simultaneously be
-- live-and-unsent toward the same destination.
CREATE UNIQUE INDEX inbox_reply_send_destination_guard ON inbox_reply_send.attempts(org_id,to_e164) WHERE state IN ('approved','claimed','dispatch_started');
-- D-6(5): sender one-in-flight. Only one attempt per sending number may be
-- mid-flight to the provider at any instant.
CREATE UNIQUE INDEX inbox_reply_send_sender_inflight ON inbox_reply_send.attempts(org_id,from_e164) WHERE state='dispatch_started';

-- D-3: BEFORE INSERT/UPDATE/DELETE transition guard. Independent of every
-- function body in this file — a bug in claim/start_dispatch/persist cannot
-- resurrect a terminal row, rewind a marker, or reuse a fence, because this
-- trigger is the last word on every write to this table.
--
-- The INSERT half also carries D-7's ledger-level P-GATE enforcement: the
-- ONLY reader of the frozen preparation row for send is frozen_item(), and a
-- row that doesn't match the frozen recipient byte-for-byte (or whose frozen
-- item carries an exclusion) is uninsertable, full stop — independent of
-- whatever validation any calling function did or didn't do.
-- text cannot itself contain a NUL byte (chr(0) as text is unrepresentable in
-- Postgres regardless of downstream use), so the chr(0) separator in D-5's
-- formula is realized at the bytea level with decode('00','hex') — the same
-- pattern inbox_operations.preparations' input_hash CHECK already uses.
CREATE FUNCTION inbox_reply_send.body_hash(rendered_body text,from_e164 text,to_e164 text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT encode(sha256(convert_to(coalesce(rendered_body,''),'utf8')||decode('00','hex')||convert_to(coalesce(from_e164,''),'utf8')||decode('00','hex')||convert_to(coalesce(to_e164,''),'utf8')),'hex')
$$;
CREATE FUNCTION inbox_reply_send.guard_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE frozen jsonb;recomputed text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable send attempt';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'approved' THEN RAISE EXCEPTION 'Invalid initial send attempt state';END IF;
  IF NEW.generation<>0 OR NEW.receipt_version<>0 OR NEW.lease_until IS NOT NULL OR NEW.dispatch_started_at IS NOT NULL OR NEW.dispatch_token IS NOT NULL OR NEW.provider_reference IS NOT NULL OR NEW.provider_status IS NOT NULL OR NEW.evidence IS NOT NULL THEN
   RAISE EXCEPTION 'Invalid initial send attempt fields';
  END IF;
  -- Serialize per-operation admission: FOR NO KEY UPDATE (not FOR UPDATE —
  -- stays compatible with the attempts FK's KEY SHARE lock and never fires
  -- operations' own immutable_row trigger) makes two concurrent inserts
  -- against the same operation queue behind each other, so the distinct-
  -- item-count cap below can never be raced past 50 by two inserts that
  -- both read "49" before either commits.
  PERFORM 1 FROM inbox_reply_send.operations WHERE org_id=NEW.org_id AND id=NEW.operation_id AND preparation_id=NEW.preparation_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Attempt preparation does not match operation';
  END IF;
  -- P-GATE 4: frozen_item raises on a missing row or exclusion IS NOT NULL.
  -- This makes such a row uninsertable regardless of any caller mistake.
  frozen:=inbox_reply_send.frozen_item(NEW.org_id,NEW.preparation_id,NEW.item_id);
  recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
  IF NEW.contact_id IS DISTINCT FROM (frozen->'recipient'->>'contactId')::uuid
     OR NEW.from_e164 IS DISTINCT FROM frozen->'recipient'->>'from'
     OR NEW.to_e164 IS DISTINCT FROM frozen->'recipient'->>'to'
     OR NEW.body_hash IS DISTINCT FROM recomputed THEN
   RAISE EXCEPTION 'Attempt does not match frozen recipient';
  END IF;
  -- D-5/D-9 recipient_limit: the operation's distinct item_id count (this
  -- insert included) must never exceed the D5 bulk-reply cap.
  IF (SELECT count(DISTINCT item_id) FROM inbox_reply_send.attempts WHERE org_id=NEW.org_id AND operation_id=NEW.operation_id AND item_id<>NEW.item_id)+1>inbox_reply_preparation.recipient_limit() THEN
   RAISE EXCEPTION 'INBOX_REPLY_RECIPIENT_LIMIT';
  END IF;
  RETURN NEW;
 END IF;
 -- UPDATE: immutable identity columns, monotonic counters, one-time markers,
 -- then the transition matrix itself.
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
  -- Reclaim: generation strictly increases; CHECK((dispatch_started_at IS
  -- NULL)=(state IN (...,'claimed',...))) already guarantees the marker is
  -- still unset on both sides of a live 'claimed' state.
  WHEN OLD.state='claimed' AND NEW.state='claimed' THEN
   IF NEW.generation<=OLD.generation THEN RAISE EXCEPTION 'Reclaim must strictly increase generation';END IF;
  WHEN OLD.state='claimed' AND NEW.state='dispatch_started' THEN
   IF NEW.dispatch_started_at IS NULL OR NEW.dispatch_token IS NULL THEN RAISE EXCEPTION 'Dispatch marker must be set exactly once here';END IF;
   -- R5 defense-in-depth (same pattern as the R3-2b window-expiry check
   -- immediately below): the marker edge is the ONE transition whose
   -- correctness depends on start_dispatch's post-marker eligibility
   -- recheck taking a fresh READ COMMITTED snapshot. A caller that bypasses
   -- start_dispatch entirely (a direct UPDATE) has no function-body assert
   -- to catch it, so the trigger itself rejects the marker write outright
   -- under any other isolation level — independent of any function-body
   -- bug, and independent of start_dispatch's own assert. Deliberately NOT
   -- applied to any other transition: claim/skip/persist edges do not carry
   -- this eligibility-snapshot dependency.
   IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'INBOX_REPLY_UNSUPPORTED_ISOLATION' USING ERRCODE='0A000';
   END IF;
   -- R3-2b defense-in-depth (same D-3/P-GATE-4 pattern as the INSERT path,
   -- which already pays this one-row frozen_item() read): a marker whose
   -- own timestamp is already past the frozen conversation window is
   -- unwritable regardless of any function-body bug in start_dispatch.
   IF NEW.dispatch_started_at>=(inbox_reply_send.frozen_item(NEW.org_id,NEW.preparation_id,NEW.item_id)->>'validUntil')::timestamptz THEN
    RAISE EXCEPTION 'INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER';
   END IF;
  WHEN OLD.state='claimed' AND NEW.state='skipped_ineligible' THEN NULL;
  WHEN OLD.state='dispatch_started' AND NEW.state IN ('provider_accepted','uncertain','confirmed_not_submitted') THEN NULL;
  WHEN OLD.state='uncertain' AND NEW.state='provider_accepted' THEN NULL;
  WHEN OLD.state='provider_accepted' AND NEW.state IN ('delivered','delivery_failed') THEN NULL;
  ELSE RAISE EXCEPTION 'Invalid send attempt transition: % -> %',OLD.state,NEW.state;
 END CASE;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_reply_send_attempt BEFORE INSERT OR UPDATE OR DELETE ON inbox_reply_send.attempts FOR EACH ROW EXECUTE FUNCTION inbox_reply_send.guard_attempt();

-- D-7: the ONLY reader of the frozen preparations row for send.
CREATE FUNCTION inbox_reply_send.frozen_item(o uuid,preparation_id uuid,item_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE prep inbox_reply_review.preparations;item jsonb;
BEGIN
 IF o IS NULL OR preparation_id IS NULL OR item_id IS NULL THEN RAISE EXCEPTION 'INBOX_REPLY_ITEM_UNAVAILABLE';END IF;
 SELECT * INTO prep FROM inbox_reply_review.preparations WHERE org_id=o AND id=preparation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ITEM_UNAVAILABLE';END IF;
 SELECT value INTO item FROM jsonb_array_elements(prep.items) value WHERE (value->>'id')::uuid=item_id;
 IF item IS NULL OR item->>'exclusion' IS NOT NULL THEN RAISE EXCEPTION 'INBOX_REPLY_ITEM_UNAVAILABLE';END IF;
 -- D-7: return ONLY recipient, validUntil, state, dependencies->>'head' and
 -- target — never the whole frozen item (which also carries id, exclusion,
 -- duplicateDestination and the full dependencies snapshot no caller here
 -- needs or should see).
 RETURN jsonb_build_object('recipient',item->'recipient','validUntil',item->'validUntil','state',item->'state','target',item->'target','dependencies',jsonb_build_object('head',item->'dependencies'->>'head'));
END $$;

-- D-8: live eligibility re-check at dispatch time. NULL = eligible, else the
-- exclusion code. Deliberately narrow (P3): does not compare the full
-- policy/known_reply/target/sender/context snapshot — only the five facts
-- listed in the ruling. A contact rename between freeze and dispatch must
-- NOT skip a reviewed send.
CREATE FUNCTION inbox_reply_send.item_current(o uuid,item jsonb) RETURNS text LANGUAGE plpgsql SET search_path='' AS $$
DECLARE qh jsonb;policy_result jsonb;sender public.provider_sender_numbers;head public.inbox_inbound_heads;
BEGIN
 -- R4 (binding, isolation contract): the post-marker savepoint recheck in
 -- start_dispatch relies on EVERY plpgsql statement in THIS function taking a
 -- FRESH snapshot under READ COMMITTED. Under REPEATABLE READ/SERIALIZABLE
 -- the transaction snapshot is pinned at the first query, so this function
 -- (called a second time after the marker UPDATE) would see the SAME stale
 -- snapshot and miss a suppression committed during the marker's lock-wait —
 -- silently reverting the R3 fix and issuing a token to a now-suppressed
 -- destination. Fail fast rather than risk that: every eligibility-recheck
 -- caller (start_dispatch pre-marker + post-marker, and any future PR-E
 -- accept-path E4 reuse) MUST run under READ COMMITTED, full stop.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'INBOX_REPLY_UNSUPPORTED_ISOLATION' USING ERRCODE='0A000';
 END IF;
 -- INVARIANT: the last eligibility read happens after the last statement
 -- that can WAIT in the transaction; the marker UPDATE is the last
 -- statement that can wait, so item_current runs once MORE after it
 -- returns (see start_dispatch). Inside this function that same invariant
 -- means BOTH canonical FOR SHARE locks — sender, then head — are acquired
 -- FIRST, and only then are ALL FIVE eligibility facts evaluated (including
 -- validUntil and quiet_hours, which round 2 left evaluated before the
 -- locks — a concurrent writer racing the head/sender lock while this
 -- function is mid-wait was still invisible to a validUntil/quiet_hours
 -- check already made from an earlier statement). Each plpgsql statement
 -- takes a fresh snapshot under READ COMMITTED, so if a concurrent writer
 -- holds either row locked (e.g. touching it as part of committing a
 -- suppression) we block here, and once we unblock, EVERY eligibility read
 -- below — all later, separate statements — is guaranteed to see whatever
 -- that writer just committed. Only the lock acquisition and the
 -- clock_timestamp() sampling move; the exclusion precedence itself
 -- (validUntil -> quiet_hours -> destination_policy -> sender -> head) is
 -- unchanged. This function and destination_policy() MUST stay VOLATILE
 -- (never STABLE) — STABLE would pin the snapshot for the whole function
 -- call and silently revert this fix. Never FOR UPDATE on heads/versions or
 -- any suppression table, matching the prepare/worker lock inversion note;
 -- and never take head FOR UPDATE before a sender write-lock in any future
 -- caller — that specific order is the one shape that can deadlock against
 -- this function's own sender-then-head lock order.
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
END $$;

-- D-9: claim/reclaim. Admission-gated (deliberate; persist is not).
CREATE FUNCTION inbox_reply_send.claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;new_generation bigint;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_UNAVAILABLE';END IF;
 IF (SELECT count(DISTINCT item_id) FROM inbox_reply_send.attempts WHERE org_id=o AND operation_id=row.operation_id)>inbox_reply_preparation.recipient_limit() THEN
  RAISE EXCEPTION 'INBOX_REPLY_RECIPIENT_LIMIT';
 END IF;
 IF row.state='approved' OR (row.state='claimed' AND row.lease_until<=clock_timestamp() AND row.dispatch_started_at IS NULL) THEN
  UPDATE inbox_reply_send.attempts SET state='claimed',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND id=attempt_id RETURNING generation INTO new_generation;
  RETURN jsonb_build_object('kind','claimed','generation',new_generation::text);
 ELSIF row.state='claimed' THEN
  RETURN jsonb_build_object('kind','busy');
 ELSIF row.state='dispatch_started' THEN
  -- Re-entry after a crash/redeploy between the dispatch marker and any
  -- result: label uncertain, never re-claim (never a second token).
  UPDATE inbox_reply_send.attempts SET state='uncertain',evidence='reentered_without_result',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','existing','state','uncertain');
 ELSE
  RETURN jsonb_build_object('kind','existing','state',row.state);
 END IF;
END $$;

-- D-10: the fenced hand-off to the provider call. MUST be the last statement
-- in its transaction — the caller (PR-F) commits and releases every lock
-- before making the outbound provider call.
CREATE FUNCTION inbox_reply_send.start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;ev text;token uuid;cn text;
BEGIN
 -- R4/R5 (binding, isolation contract, same as item_current): this MUST be
 -- the very first statement, before the FOR UPDATE row lock below. Under
 -- REPEATABLE READ/SERIALIZABLE a caller sharing a sender with an
 -- in-flight dispatch would otherwise block on the attempt row's FOR
 -- UPDATE (or the sender-inflight index later) and surface as a lock
 -- timeout instead of a clean, immediate rejection — belt-and-suspenders
 -- with the item_current assert, since a caller could theoretically
 -- bypass item_current entirely. Reading current_setting() needs no lock.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'INBOX_REPLY_UNSUPPORTED_ISOLATION' USING ERRCODE='0A000';
 END IF;
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND OR row.state<>'claimed' OR g IS NULL OR row.generation<>g OR row.lease_until<=clock_timestamp() OR row.dispatch_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'INBOX_REPLY_STALE_CLAIM';
 END IF;
 frozen:=inbox_reply_send.frozen_item(o,row.preparation_id,row.item_id);
 recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
 IF row.body_hash IS DISTINCT FROM recomputed THEN RAISE EXCEPTION 'INBOX_REPLY_FROZEN_MISMATCH';END IF;
 -- P2.4 fast path (kept) — a cheap pre-check that avoids running item_current
 -- at all when the sender is obviously already busy. The real fence is the
 -- unique index guarding the marker UPDATE below.
 IF EXISTS(SELECT 1 FROM inbox_reply_send.attempts WHERE org_id=o AND from_e164=row.from_e164 AND state='dispatch_started' AND id<>row.id) THEN
  RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
 END IF;
 -- Pre-marker cheap skip: returns without ever touching the sender-inflight
 -- index when the item is already visibly ineligible. This does NOT
 -- satisfy the invariant below by itself — see the post-marker recheck.
 ev:=inbox_reply_send.item_current(o,frozen);
 IF ev IS NOT NULL THEN
  UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','skipped','reason',ev);
 END IF;
 token:=gen_random_uuid();
 -- INVARIANT: the last eligibility read happens after the last statement
 -- that can WAIT in the transaction; the marker UPDATE is the last
 -- statement that can wait (it can block on the D-6(5) sender-inflight
 -- unique index), so item_current runs once MORE after it returns — inside
 -- this same savepoint-shaped EXCEPTION block, so a stale-at-marker result
 -- rolls the marker/token back in-tx rather than ever being returned to a
 -- caller. The pre-marker call above is a cheap optimization only; this one
 -- is the actual gate. frozen need not be re-read (preparations are
 -- immutable) and the outer attempt row's FOR UPDATE lock is retained
 -- throughout — only the marker write itself rolls back.
 BEGIN
  UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=token,lease_until=NULL WHERE org_id=o AND id=attempt_id;
  -- The LAST read, after the marker's own wait. `ev` is reassigned here (not
  -- reused from the pre-marker call above) so a caught IR001 below records
  -- the FRESH reason as evidence.
  ev:=inbox_reply_send.item_current(o,frozen);
  IF ev IS NOT NULL THEN RAISE EXCEPTION 'stale after marker' USING ERRCODE='IR001';END IF;
 EXCEPTION
  WHEN SQLSTATE 'IR001' THEN
   -- The marker UPDATE above rolled back to this block's implicit savepoint:
   -- state, dispatch_started_at and dispatch_token are all back to their
   -- pre-BEGIN ('claimed') values, so this UPDATE's OLD.state='claimed' is a
   -- listed trigger edge, exactly like the pre-marker skip path.
   UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
   RETURN jsonb_build_object('kind','skipped','reason',ev);
  WHEN unique_violation THEN
   -- P2.4: the fast pre-check above can miss a same-instant competitor (it
   -- only sees already-committed dispatch_started rows). The D-6(5) unique
   -- index on (org_id,from_e164) WHERE state='dispatch_started' is the real
   -- fence; a unique_violation here is only ever this specific race —
   -- anything else re-raises unchanged. The 55P03 carries no DETAIL/HINT so
   -- the raw 23505 detail (which would include the phone number) never
   -- leaks. Deliberately no WHEN OTHERS here: any other error must abort
   -- the whole transaction, never be swallowed by this block.
   GET STACKED DIAGNOSTICS cn=CONSTRAINT_NAME;
   IF cn='inbox_reply_send_sender_inflight' THEN RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
   ELSE RAISE;
   END IF;
 END;
 -- Body is read VERBATIM from the frozen row (P-GATE 3/R4) — never copied
 -- into this table, never re-rendered, never re-parsed as template syntax.
 RETURN jsonb_build_object('kind','dispatch','token',token,'from',row.from_e164,'to',row.to_e164,'body',frozen->'recipient'->>'renderedBody');
END $$;

-- D-11: reconcile a provider result. Deliberately NOT admission-gated — a
-- result already in flight must always be recordable so the ledger never
-- drifts from reality merely because admission was flipped off mid-flight.
CREATE FUNCTION inbox_reply_send.persist(o uuid,attempt_id uuid,token uuid,result jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;kind text;reference text;reason text;v bigint;
BEGIN
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND OR token IS NULL OR row.dispatch_token IS DISTINCT FROM token THEN RAISE EXCEPTION 'INBOX_REPLY_STALE_TOKEN';END IF;
 -- B1: compute kind first and check it for NULL explicitly. `result->>'kind'
 -- NOT IN (...)` is itself NULL (never TRUE) when the key is absent or JSON
 -- null, so a `{}` or `{"kind":null}` result previously sailed past this
 -- guard and fell into the ELSE branch below as a silent not_attempted ->
 -- confirmed_not_submitted (a terminal state that frees a successor attempt
 -- for the same item) — a double/wrong-send door with no explicit result at
 -- all. jsonb_typeof(result) is checked first so kind:=result->>'kind' is
 -- always evaluated against a genuine object.
 IF jsonb_typeof(result) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid dispatch result';END IF;
 kind:=result->>'kind';
 IF kind IS NULL OR kind NOT IN ('accepted','not_attempted','uncertain') THEN RAISE EXCEPTION 'Invalid dispatch result';END IF;
 IF row.state='dispatch_started' THEN
  IF kind='accepted' THEN
   reference:=result->>'externalId';
   IF reference IS NULL OR btrim(reference)='' OR octet_length(reference)>512 THEN RAISE EXCEPTION 'Invalid provider reference';END IF;
   UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference=reference,provider_status=left(result->>'status',128),receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id RETURNING receipt_version INTO v;
   RETURN jsonb_build_object('state','provider_accepted','receipt_version',v::text);
  ELSIF kind='uncertain' THEN
   reason:=coalesce(result->>'reason','unknown');
   UPDATE inbox_reply_send.attempts SET state='uncertain',evidence=left(reason,128),receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id RETURNING receipt_version INTO v;
   RETURN jsonb_build_object('state','uncertain','receipt_version',v::text);
  ELSIF kind='not_attempted' THEN
   -- B2: D-4 bounds not_attempted's reason to the two proven-non-submit
   -- codes. A provider TIMEOUT (or any other reason) is NOT a proven
   -- non-submit — it is uncertain by definition — so it must never reach
   -- confirmed_not_submitted, a terminal state that frees a successor
   -- attempt. Any other reason raises rather than silently defaulting.
   reason:=result->>'reason';
   IF reason IS NULL OR reason NOT IN ('invalid_input','cancelled_before_dispatch') THEN RAISE EXCEPTION 'Invalid not_attempted reason';END IF;
   UPDATE inbox_reply_send.attempts SET state='confirmed_not_submitted',evidence=left('local_not_attempted:'||reason,128),receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id RETURNING receipt_version INTO v;
   RETURN jsonb_build_object('state','confirmed_not_submitted','receipt_version',v::text);
  END IF;
 ELSIF row.state='uncertain' THEN
  IF kind='accepted' THEN
   reference:=result->>'externalId';
   IF reference IS NULL OR btrim(reference)='' OR octet_length(reference)>512 THEN RAISE EXCEPTION 'Invalid provider reference';END IF;
   UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference=reference,provider_status=left(result->>'status',128),receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id RETURNING receipt_version INTO v;
   RETURN jsonb_build_object('state','provider_accepted','receipt_version',v::text);
  ELSIF kind='uncertain' THEN
   RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text);
  ELSE
   RAISE EXCEPTION 'INBOX_REPLY_INVALID_PERSIST_TRANSITION';
  END IF;
 ELSIF row.state IN ('provider_accepted','delivered','delivery_failed') THEN
  IF kind='uncertain' THEN
   RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text);
  ELSIF kind='accepted' THEN
   reference:=result->>'externalId';
   IF reference IS NOT DISTINCT FROM row.provider_reference THEN
    RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text);
   ELSE
    RAISE EXCEPTION 'INBOX_REPLY_CONTRADICTORY_RECEIPT';
   END IF;
  ELSE
   RAISE EXCEPTION 'INBOX_REPLY_INVALID_PERSIST_TRANSITION';
  END IF;
 ELSE
  RAISE EXCEPTION 'INBOX_REPLY_INVALID_PERSIST_TRANSITION';
 END IF;
END $$;

DO $$ DECLARE t record;BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='inbox_reply_send' LOOP EXECUTE format('ALTER TABLE inbox_reply_send.%I ENABLE ROW LEVEL SECURITY',t.tablename);END LOOP;END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_send FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_send FROM PUBLIC;
DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA inbox_reply_send FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_send FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_send FROM %I',r.rolname);
 END LOOP;
END $$;



-- Pinned reply_accept_recovery: experiments/inbox-reply-send/accept.sql
-- source_sha256=375fcb63bdd59e14168f49b05e46ab33f2f4f55c04e72ea5242b4165f6a54621
-- Lane 1 PR-E: wires PR-D's durable send-attempt ledger to the accept path.
-- Additive only — does NOT touch attempts.sql. Flags stay OFF, admission
-- stays CLOSED (require_admission() below), no sends, no worker. This file
-- adds: accept()/recover()/operation_status() in inbox_reply_send, plus a
-- durable dispatch_outbox table so an accepted operation can never be
-- stranded by a crash right after acceptance (PR-F consumes this outbox
-- with a durable claim/ack + recovery scan; this PR only creates the table
-- and the in-commit insert).
--
-- Astra #1 (atomic accept): the whole accept is ONE transaction inserting
-- the operations row + N attempts rows + the outbox row. The BEGIN/
-- EXCEPTION block below only inspects the failing constraint name before
-- re-raising a sanitized, distinct code — the re-raise still aborts the
-- WHOLE enclosing transaction (Postgres exception semantics), so a partial
-- batch can never persist; there is no per-item autonomous insert path.
--
-- Astra #1 (sanitized 23505s): every re-raise below carries no DETAIL/HINT,
-- so a raw constraint-violation message (which would include the phone
-- number for the destination-guard/live-attempt indexes) never leaves this
-- function. Only inbox_reply_send_destination_guard maps to
-- destination_in_progress (55006); every other 23505 gets its own distinct
-- code, matching the brief's per-constraint mapping table.
--
-- Astra #1 (subtractive-only E4): the eligible-set loop below skips a
-- frozen-EXCLUDED item outright (never rechecked, never revived) and drops
-- a frozen-eligible item whose FRESH item_current() recheck now returns an
-- exclusion code. It can never add an item item_current() didn't already
-- allow through freeze.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;
END $$;

-- Full claim-ready shape (mirrors inbox_operations.dispatch_outbox,
-- experiments/inbox-operation-acceptance/setup.sql:60-65, plus the pending-
-- dispatch partial index) so PR-F's worker can reuse inbox-operation-
-- worker/core.mjs with no schema change. accept() below inserts only
-- (org_id,operation_id); generation/lease_until/acknowledged_at stay at
-- their defaults until PR-F's dispatcher drives them.
CREATE TABLE inbox_reply_send.dispatch_outbox(
 org_id uuid NOT NULL,operation_id uuid NOT NULL,
 event_id uuid NOT NULL DEFAULT gen_random_uuid(),
 generation bigint NOT NULL DEFAULT 0,
 lease_until timestamptz,acknowledged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,operation_id),UNIQUE(event_id),
 FOREIGN KEY(org_id,operation_id) REFERENCES inbox_reply_send.operations(org_id,id)
);
CREATE INDEX inbox_reply_send_pending_dispatch ON inbox_reply_send.dispatch_outbox(created_at,event_id) WHERE acknowledged_at IS NULL;

-- D-1: single transaction. Steps numbered per the architect brief.
CREATE FUNCTION inbox_reply_send.accept(o uuid,requester uuid,k uuid,preparation_id uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE
 existing_op inbox_reply_send.operations;
 relookup inbox_reply_send.operations;
 prep inbox_reply_review.preparations;
 raw_item jsonb;
 ev text;
 eligible jsonb:='[]'::jsonb;
 eligible_count integer;
 op_id uuid;
 accepted_at timestamptz;
 cn text;
BEGIN
 -- 1. Isolation assert, first statement (same guard as attempts.sql's
 -- item_current/start_dispatch): the fresh-snapshot E4 recheck below
 -- depends on it.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'INBOX_REPLY_UNSUPPORTED_ISOLATION' USING ERRCODE='0A000';
 END IF;
 IF o IS NULL OR requester IS NULL OR k IS NULL OR preparation_id IS NULL THEN RAISE EXCEPTION 'Invalid accept identity';END IF;
 -- 2. Admission: keeps accept inert while the flag/admission are off.
 PERFORM inbox_reply_review.require_admission();
 -- Astra round-3 finding: an identical retry (same org,requester,key,
 -- preparation) that starts before the winner commits, then gets delayed
 -- past prep.expires_at by ANY lock wait further down (e.g. item_current's
 -- sender/head FOR SHARE), would reach the expiry check below BEFORE the
 -- winner's row was visible to its own step-3 pre-check — raising a
 -- spurious INBOX_REPLY_PREPARATION_EXPIRED for a request that was, in
 -- fact, already accepted. A client retrying after a dropped response must
 -- ALWAYS get the operation back, never a spurious expiry.
 --
 -- Fix (authoritative serialization, taken as the FIRST locking step, right
 -- after admission and BEFORE step 3): a transaction-scoped advisory lock
 -- keyed on (org,requester,key). Two identical-key accepts now serialize
 -- completely — the second blocks HERE until the first commits (the xact
 -- lock auto-releases at commit/rollback), so its step-3 pre-check
 -- authoritatively sees the committed operation and replays it before ever
 -- reaching the expiry check. Expiry then only ever rejects a GENUINELY
 -- unaccepted preparation (no competing operation for this exact key). This
 -- also subsumes the insert-time unique-violation race the exception
 -- handler below resolves — that handler stays as defense in depth, never
 -- the primary mechanism.
 --
 -- pg_advisory_XACT_lock (not the session-scoped variant): the lock must
 -- release automatically at this transaction's end, never require an
 -- explicit unlock call this function doesn't make. Keyed by (org,requester,
 -- key) only — DIFFERENT keys never contend, so unrelated accepts are
 -- unaffected; identical keys always serialize. Taken first (before every
 -- other lock in this function — require_admission()'s FOR SHARE,
 -- authorize()'s access-epoch FOR SHARE, item_current()'s sender/head FOR
 -- SHARE), so there is no lock-order inversion with any of them: this
 -- advisory lock is never acquired AFTER a row lock in the same
 -- transaction, only before. The expiry read itself stays exactly where it
 -- was — the LAST statement before the insert, after every row-lock-
 -- capable statement — so the expiry-after-locks invariant is unchanged;
 -- this advisory lock is additional, not a replacement.
 PERFORM pg_advisory_xact_lock(hashtextextended(o::text||':'||requester::text||':'||k::text,0));
 -- 3. Idempotent-replay resolution, before any insert.
 SELECT * INTO existing_op FROM inbox_reply_send.operations WHERE org_id=o AND requester_id=requester AND idempotency_key=k;
 IF FOUND THEN
  IF existing_op.preparation_id=preparation_id THEN
   RETURN jsonb_build_object('operation_id',existing_op.id,'preparation_id',existing_op.preparation_id,'accepted_at',existing_op.created_at);
  ELSE
   RAISE EXCEPTION 'INBOX_REPLY_KEY_REUSED';
  END IF;
 END IF;
 -- 4. Preparation lookup + binding + expiry. Preparations are immutable
 -- (immutable_reply_preparation trigger blocks UPDATE/DELETE for every
 -- non-owner role), so no row lock is required to read it safely; the
 -- expires_at check itself is deferred to just before the insert below (see
 -- note there) so a lock-wait earlier in this function cannot push the
 -- accept past expiry without being caught (mirrors PR-D R3-2).
 SELECT * INTO prep FROM inbox_reply_review.preparations WHERE org_id=o AND id=preparation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 IF prep.request_key<>k THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_KEY_MISMATCH';END IF;
 -- 5. Requester authorization: reuses inbox_action_api.authorize(o,u), the
 -- SAME live session/membership check capture()/freeze() already run (and
 -- re-run post-batch) for this lane. A revoked/mismatched requester raises
 -- INBOX_ACTION_FORBIDDEN (42501), already mapped to 403 by reply-api.ts's
 -- failure(). A preparation requested by someone else can never be accepted
 -- by this caller even if the caller's own membership is fine.
 PERFORM inbox_action_api.authorize(o,requester);
 IF prep.requester_id<>requester THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 -- 6. Eligible set: subtractive-only E4 recheck via item_current(). A
 -- frozen-EXCLUDED item (exclusion IS NOT NULL) is skipped WITHOUT any
 -- recheck — never revived. A frozen-eligible item that is now
 -- ineligible (item_current returns a code) or now duplicate-destination is
 -- DROPPED, never re-added. Nothing here can add an item item_current()
 -- wouldn't independently allow.
 FOR raw_item IN SELECT value FROM jsonb_array_elements(prep.items) LOOP
  IF raw_item->>'exclusion' IS NOT NULL THEN CONTINUE;END IF;
  IF coalesce((raw_item->>'duplicateDestination')::boolean,false) THEN CONTINUE;END IF;
  ev:=inbox_reply_send.item_current(o,raw_item);
  IF ev IS NOT NULL THEN CONTINUE;END IF;
  eligible:=eligible||jsonb_build_array(jsonb_build_object(
   'item_id',raw_item->>'id','contact_id',raw_item->'recipient'->>'contactId',
   'from_e164',raw_item->'recipient'->>'from','to_e164',raw_item->'recipient'->>'to',
   'rendered_body',raw_item->'recipient'->>'renderedBody'));
 END LOOP;
 eligible_count:=jsonb_array_length(eligible);
 -- 7. 50-cap up front (E4/D5). guard_attempt()'s own per-insert cap is the
 -- backstop; this rejects an already-over-cap batch before creating
 -- anything at all.
 IF eligible_count>inbox_reply_preparation.recipient_limit() THEN RAISE EXCEPTION 'INBOX_REPLY_RECIPIENT_LIMIT';END IF;
 -- Expiry, read last (after every lock-wait-capable statement above:
 -- require_admission's FOR SHARE, authorize()'s access-epoch FOR SHARE) so
 -- a caller delayed past expires_at by a lock wait is still rejected —
 -- clock_timestamp() here is a fresh read, never reused from step 4.
 IF prep.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_EXPIRED';END IF;
 -- 8-9. Atomic insert: operations row + N attempts rows + ONE dispatch_outbox
 -- row, all in THIS transaction/commit (Astra #2). ANY conflict below rolls
 -- back the ENTIRE batch — see the file-header note on exception semantics.
 BEGIN
  INSERT INTO inbox_reply_send.operations(org_id,requester_id,preparation_id,idempotency_key) VALUES(o,requester,preparation_id,k) RETURNING id,created_at INTO op_id,accepted_at;
  IF eligible_count>0 THEN
   INSERT INTO inbox_reply_send.attempts(org_id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
    SELECT o,op_id,preparation_id,(x->>'item_id')::uuid,1,(x->>'contact_id')::uuid,x->>'from_e164',x->>'to_e164',
     inbox_reply_send.body_hash(x->>'rendered_body',x->>'from_e164',x->>'to_e164'),'approved'
    FROM jsonb_array_elements(eligible) x;
  END IF;
  INSERT INTO inbox_reply_send.dispatch_outbox(org_id,operation_id) VALUES(o,op_id);
 EXCEPTION
  WHEN unique_violation THEN
   -- Every branch re-raises a sanitized, message-keyed P0001 (no
   -- DETAIL/HINT — the raw 23505 detail would include the phone number for
   -- the destination-guard/live-attempt indexes). reply-api.ts's P0001
   -- conflicts map turns each distinct message into its own HTTP code.
   GET STACKED DIAGNOSTICS cn=CONSTRAINT_NAME;
   IF cn='inbox_reply_send_destination_guard' THEN RAISE EXCEPTION 'INBOX_REPLY_DESTINATION_IN_PROGRESS';
   ELSIF cn IN ('inbox_reply_send_live_attempt','inbox_reply_send_attempt_ordinal','inbox_reply_send_attempt_successor') THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_IDENTITY';
   ELSIF cn IN ('operations_org_id_preparation_id_key','operations_org_id_requester_id_idempotency_key_key') THEN
    -- Astra round-2 finding: do NOT route the idempotency decision on WHICH
    -- of these two operations-table unique indexes fired. A race between
    -- two accepts sharing the SAME (org,requester,key,preparation) violates
    -- BOTH indexes at once, and Postgres reports whichever it happens to
    -- check first — non-deterministic from this function's point of view.
    -- Routing on cn alone would let that race's loser wrongly see
    -- PREPARATION_ACCEPTED instead of replaying the winner's operation, so
    -- a legitimate same-key retry could get a false conflict instead of the
    -- idempotent operationId it's entitled to. Resolve BOTH constraint
    -- names identically, by re-looking up the existing operation by
    -- (org,requester,key) — the same predicate step 3 already used, and the
    -- ONLY reliable signal for "is this actually the same request replaying
    -- or a genuine conflict":
    --  * found, same preparation_id -> idempotent replay, regardless of
    --    which index fired (this is the race step 3's own pre-check can
    --    lose: a concurrent accept committed the same key between our
    --    pre-check and this insert).
    --  * found, different preparation_id -> a genuine key reuse.
    --  * not found by key at all -> this insert's OWN key never matched an
    --    existing operation, so the conflict can only be the OTHER caller's
    --    key already holding this preparation -> preparation already
    --    accepted under a different key.
    SELECT * INTO relookup FROM inbox_reply_send.operations WHERE org_id=o AND requester_id=requester AND idempotency_key=k;
    IF FOUND THEN
     IF relookup.preparation_id=preparation_id THEN
      RETURN jsonb_build_object('operation_id',relookup.id,'preparation_id',relookup.preparation_id,'accepted_at',relookup.created_at);
     ELSE
      RAISE EXCEPTION 'INBOX_REPLY_KEY_REUSED';
     END IF;
    ELSE
     RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_ACCEPTED';
    END IF;
   ELSE
    RAISE;
   END IF;
 END;
 RETURN jsonb_build_object('operation_id',op_id,'preparation_id',preparation_id,'accepted_at',accepted_at);
END $$;

-- Mirrors inbox_recover_operation (action-api.ts:150 / review.sql). Given
-- (requester,key,preparation): an existing operation -> 'accepted'; no
-- operation and an expired preparation -> 'expired_not_accepted'; else
-- 'prepared' (reply-api-contract.ts's InboxReplyRecovery vocabulary — the
-- metadata lane's analogous state is spelled 'pending', reply's is
-- 'prepared'; both mean "no operation yet, not expired"). Requester-scoped:
-- a different requester can never recover another's operation or even see
-- whether their preparation exists.
CREATE FUNCTION inbox_reply_send.recover(o uuid,requester uuid,k uuid,preparation_id uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE existing_op inbox_reply_send.operations;prep inbox_reply_review.preparations;
BEGIN
 IF o IS NULL OR requester IS NULL OR k IS NULL OR preparation_id IS NULL THEN RAISE EXCEPTION 'Invalid recovery reference';END IF;
 PERFORM inbox_action_api.authorize(o,requester);
 SELECT * INTO prep FROM inbox_reply_review.preparations WHERE org_id=o AND id=preparation_id;
 IF NOT FOUND OR prep.requester_id<>requester THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 IF prep.request_key<>k THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_KEY_MISMATCH';END IF;
 SELECT * INTO existing_op FROM inbox_reply_send.operations WHERE org_id=o AND requester_id=requester AND idempotency_key=k;
 IF FOUND THEN
  IF existing_op.preparation_id<>preparation_id THEN RAISE EXCEPTION 'INBOX_REPLY_KEY_REUSED';END IF;
  RETURN jsonb_build_object('state','accepted','operation',jsonb_build_object('operationId',existing_op.id,'preparationId',existing_op.preparation_id,'idempotencyKey',k));
 ELSE
  RETURN jsonb_build_object('state',CASE WHEN prep.expires_at<=clock_timestamp() THEN 'expired_not_accepted' ELSE 'prepared' END,'preparationId',preparation_id,'idempotencyKey',k,'operation',NULL);
 END IF;
END $$;

-- Mirrors inbox_operation_status (action-api.ts:158). Total, exhaustive
-- per-attempt state->wire mapping: the CASE below has no ELSE, so an
-- attempts.state value outside the ten literals the CHECK constraint
-- permits raises CASE_NOT_FOUND rather than silently defaulting.
CREATE FUNCTION inbox_reply_send.operation_status(o uuid,target_operation_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE op inbox_reply_send.operations;prep inbox_reply_review.preparations;receipts jsonb;complete boolean;
BEGIN
 IF o IS NULL OR target_operation_id IS NULL THEN RAISE EXCEPTION 'Invalid operation reference';END IF;
 SELECT * INTO op FROM inbox_reply_send.operations WHERE org_id=o AND id=target_operation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_OPERATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 SELECT * INTO prep FROM inbox_reply_review.preparations WHERE org_id=o AND id=op.preparation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_OPERATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
    'itemId',a.item_id,'attemptId',a.id,'version',a.receipt_version::text,
    'state',CASE a.state
     WHEN 'approved' THEN 'pending' WHEN 'claimed' THEN 'pending'
     WHEN 'dispatch_started' THEN 'dispatch_started'
     WHEN 'skipped_ineligible' THEN 'blocked'
     WHEN 'provider_accepted' THEN 'provider_accepted'
     WHEN 'uncertain' THEN 'uncertain'
     WHEN 'confirmed_not_submitted' THEN 'confirmed_not_submitted'
     WHEN 'rejected_unsent' THEN 'rejected_unsent'
     WHEN 'delivered' THEN 'delivered'
     WHEN 'delivery_failed' THEN 'delivery_failed'
    END,
    'reason',a.evidence) ORDER BY a.item_id),'[]'::jsonb),
   bool_and(a.state IN ('provider_accepted','delivered','delivery_failed','rejected_unsent','confirmed_not_submitted'))
  INTO receipts,complete FROM inbox_reply_send.attempts a WHERE a.org_id=o AND a.operation_id=target_operation_id;
 RETURN jsonb_build_object('operationId',op.id,'preparationId',op.preparation_id,'dispatchComplete',coalesce(complete,true),'items',prep.items,'receipts',receipts);
END $$;

DO $$ DECLARE t record;BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='inbox_reply_send' LOOP EXECUTE format('ALTER TABLE inbox_reply_send.%I ENABLE ROW LEVEL SECURITY',t.tablename);END LOOP;END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_send FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_send FROM PUBLIC;
DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA inbox_reply_send FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_send FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_send FROM %I',r.rolname);
 END LOOP;
END $$;



-- Pinned reply_callback: experiments/inbox-reply-send/callback.sql
-- source_sha256=71ec54276bbd13e70408586c2efd151f5811b06ac8b31d238a542ae30a39f66c
-- Lane 1 PR-G: reply-specific Sendillo callback ingress + reconciliation.
-- Additive only — does NOT touch attempts.sql/accept.sql (byte-identical to
-- merged). Drives provider_accepted -> delivered|delivery_failed, the ONE
-- trigger edge attempts.sql already allows (attempts.sql:244) but that no
-- function before this file exercised.
--
-- Astra #6 (do not reuse the Outbox webhook helpers): public.webhook_events
-- (supabase/migrations/001_initial.sql:287-303) has NO org_id column and NO
-- lease/generation columns at all — confirmed by inspection, not assumed.
-- Retrofitting org-scoping + lease-fencing onto that shared table would
-- either widen a table other providers/lanes depend on, or bolt fencing onto
-- a dedup key `(provider,event_type,external_id)` that already has no
-- concept of a lease owner. Instead this file adds a NEW, fully-owned
-- reservation table in this schema (inbox_reply_send.callback_receipts)
-- with its own org_id + lease_owner/lease_generation columns, reachable only
-- through the service-role wrapper below. Its event_type is always prefixed
-- `inbox_reply_status_`, so its dedup key can never collide with the
-- Outbox's `sms_status_*` rows even if both tables are ever compared side by
-- side.
--
-- Astra #5 (callback-before-persist tolerance): persist() (attempts.sql:439)
-- is the ONLY writer of attempts.provider_reference, and it can commit AFTER
-- a delivery callback for the same reference already arrived. A callback
-- whose reference does not yet match any attempt is stored durably in
-- unmatched_callbacks (never discarded, never matched by phone) and later
-- drained by drain_unmatched() once persist() binds the reference. uncertain
-- attempts whose only identity was a dropped reportedExternalId
-- (attempts.sql:462 keeps only evidence) are NOT auto-reconciled by this
-- file — see the [ARCH] note below; their callbacks still land durably in
-- unmatched_callbacks for audit/manual association, never dropped.
--
-- No blind retry: nothing here ever calls the reply provider or issues a
-- new dispatch. This file only ever moves a row that is ALREADY
-- provider_accepted to a terminal state, or leaves it untouched.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;
END $$;

-- [ARCH] Global-unique on the Sendillo externalId: Sendillo's own message
-- ids are globally unique, so a callback can be matched by reference alone
-- without knowing the org up front (the webhook carries no org identity).
-- A second persist() binding an already-used reference now hits 23505
-- instead of silently mis-associating two attempts with one provider
-- message. provider_reference never carries phone/body content (it is the
-- provider's own opaque id, CHECK-bounded at attempts.sql:110), so the raw
-- constraint DETAIL from a 23505 here cannot leak a phone number even
-- unsanitized — verified by proof, not merely asserted.
CREATE UNIQUE INDEX inbox_reply_send_provider_reference ON inbox_reply_send.attempts(provider_reference) WHERE provider_reference IS NOT NULL;

-- Astra #5: durable holding table for a callback that arrived before the
-- matching persist() committed. No org column — org is unknown until a
-- matching attempts row exists. PRIMARY KEY(provider,provider_reference)
-- makes the insert itself the dedup key; ON CONFLICT DO NOTHING below means
-- the FIRST captured terminal status for a given reference is retained
-- (first-terminal-wins, mirroring reconcile_delivery's own precedence) —
-- never overwritten by a later, possibly-contradictory redelivery, and
-- never discarded either way.
CREATE TABLE inbox_reply_send.unmatched_callbacks(
 provider text NOT NULL,
 provider_reference text NOT NULL CHECK(provider_reference<>'' AND octet_length(provider_reference)<=512),
 terminal_status text NOT NULL CHECK(terminal_status IN ('delivered','delivery_failed')),
 payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(provider,provider_reference)
);

-- Astra #6: the reply-namespaced, org-scoped, lease-fenced idempotency
-- table. Only ever written for a MATCHED callback (org known) — an
-- unmatched callback dedups in unmatched_callbacks above instead, exactly
-- as the brief requires (never a sentinel-org row here). event_type is
-- always 'inbox_reply_status_delivered' or 'inbox_reply_status_delivery_failed',
-- so PRIMARY KEY(provider,event_type,external_id) can never collide with
-- the Outbox's own `sms_status_*` webhook_events rows even though the key
-- shape looks similar — this is a wholly separate table.
CREATE TABLE inbox_reply_send.callback_receipts(
 org_id uuid NOT NULL,
 provider text NOT NULL,
 event_type text NOT NULL CHECK(event_type IN ('inbox_reply_status_delivered','inbox_reply_status_delivery_failed')),
 external_id text NOT NULL CHECK(external_id<>'' AND octet_length(external_id)<=512),
 processing_status text NOT NULL DEFAULT 'processing' CHECK(processing_status IN ('processing','processed','error')),
 lease_owner uuid NOT NULL,
 lease_generation bigint NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
 lease_until timestamptz NOT NULL,
 payload jsonb NOT NULL,
 error_message text CHECK(error_message IS NULL OR octet_length(error_message)<=256),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 processed_at timestamptz,
 PRIMARY KEY(provider,event_type,external_id)
);
CREATE INDEX inbox_reply_send_callback_receipts_org ON inbox_reply_send.callback_receipts(org_id);

-- D-11-style reconcile: the ONLY function that drives provider_accepted ->
-- delivered|delivery_failed. FOR UPDATE mirrors persist()'s own locking.
-- Org-scoped (WHERE org_id=o AND ...): a reference that exists but under a
-- DIFFERENT org is NOT FOUND here (rejected), never touched — this is what
-- makes a cross-org callback safely a no-op/reject rather than a leak or a
-- cross-tenant write, independent of how the caller resolved `o`.
--
-- Status precedence [ARCH]: terminal states are mutually exclusive and
-- first-terminal-wins. A matching redelivery (row already at `terminal`) is
-- an idempotent no-op. A genuinely contradictory second terminal (delivered
-- then delivery_failed, or vice-versa) raises INBOX_REPLY_CONTRADICTORY_RECEIPT
-- — reusing persist()'s own code for the same underlying concept (attempts.sql:495)
-- — and never silently flips the row.
CREATE FUNCTION inbox_reply_send.reconcile_delivery(o uuid,provider text,provider_reference text,terminal text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;v bigint;
BEGIN
 IF o IS NULL OR provider IS DISTINCT FROM 'sendillo' OR provider_reference IS NULL OR btrim(provider_reference)='' OR terminal NOT IN ('delivered','delivery_failed') OR jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'INBOX_REPLY_INVALID_CALLBACK';
 END IF;
 SELECT * INTO row FROM inbox_reply_send.attempts a WHERE a.org_id=o AND a.provider_reference=reconcile_delivery.provider_reference FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'INBOX_REPLY_CALLBACK_UNMATCHED';
 END IF;
 IF row.state='provider_accepted' THEN
  UPDATE inbox_reply_send.attempts SET state=terminal,receipt_version=receipt_version+1 WHERE org_id=o AND id=row.id RETURNING receipt_version INTO v;
  RETURN jsonb_build_object('state',terminal,'receipt_version',v::text,'applied',true);
 ELSIF row.state IN ('delivered','delivery_failed') THEN
  IF row.state=terminal THEN
   RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text,'applied',false);
  ELSE
   RAISE EXCEPTION 'INBOX_REPLY_CONTRADICTORY_RECEIPT';
  END IF;
 ELSE
  -- Includes 'uncertain' deliberately: [ARCH] this file never reopens the
  -- merged ledger to bind a dropped reportedExternalId, so an uncertain
  -- attempt is never auto-reconciled by reference here even if a later
  -- callback happens to name it (it can't — uncertain rows have no
  -- provider_reference, so the lookup above would never have found them in
  -- the first place; this branch exists only as defense-in-depth for any
  -- future caller).
  RAISE EXCEPTION 'INBOX_REPLY_INVALID_PERSIST_TRANSITION';
 END IF;
END $$;

-- Astra #5: drains a now-persisted reference's holding row. FOR UPDATE on
-- the holding row serializes concurrent drains of the SAME reference; once
-- reconcile_delivery succeeds the holding row is deleted, so a second call
-- (opportunistic ingress retry + a later sweep both racing the same
-- reference) finds NOT FOUND and is a clean no-op — applies exactly once.
CREATE FUNCTION inbox_reply_send.drain_unmatched(provider text,provider_reference text) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE held inbox_reply_send.unmatched_callbacks;att_org uuid;result jsonb;
BEGIN
 SELECT * INTO held FROM inbox_reply_send.unmatched_callbacks u WHERE u.provider=drain_unmatched.provider AND u.provider_reference=drain_unmatched.provider_reference FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('drained',false,'reason','no_holding_row');END IF;
 SELECT a.org_id INTO att_org FROM inbox_reply_send.attempts a WHERE a.provider_reference=drain_unmatched.provider_reference;
 IF NOT FOUND THEN RETURN jsonb_build_object('drained',false,'reason','still_unmatched');END IF;
 result:=inbox_reply_send.reconcile_delivery(att_org,held.provider,held.provider_reference,held.terminal_status,held.payload);
 DELETE FROM inbox_reply_send.unmatched_callbacks u WHERE u.provider=drain_unmatched.provider AND u.provider_reference=drain_unmatched.provider_reference;
 RETURN jsonb_build_object('drained',true,'result',result);
END $$;

-- [Astra fix-1] Durable recovery sweep, mirroring the Outbox's cron-driven
-- reconciliation ARCHITECTURE (src/app/api/cron/sendillo-status-reconciliation/
-- route.ts — a periodic sweep over rows that never got a second event to
-- trigger inline reconciliation), never its code or its table. Scans
-- unmatched_callbacks for a reference that NOW matches a persisted attempt
-- (the case where a callback arrived before persist(), persist() later
-- bound the reference, but no SECOND callback ever arrived to trigger the
-- wrapper's own drain-first step below) and drains each one. Safe to run
-- repeatedly/concurrently with itself or with the wrapper's own drain call:
-- drain_unmatched's FOR UPDATE + delete makes a losing concurrent drain of
-- the SAME reference a clean no-op. Each row's drain runs in its own
-- exception-isolated block (an implicit savepoint) so one contradictory or
-- otherwise-failing row (e.g. a held terminal that genuinely conflicts with
-- one applied through the wrapper's own drain-first path in the interim)
-- is skipped and left stranded for manual/audit resolution, never aborting
-- the whole batch — every other candidate in this sweep still gets tried.
CREATE FUNCTION inbox_reply_send.sweep_unmatched_callbacks(batch_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r record;drained_count integer:=0;scanned_count integer:=0;failed_count integer:=0;
BEGIN
 IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid batch_limit';END IF;
 FOR r IN
  SELECT u.provider,u.provider_reference FROM inbox_reply_send.unmatched_callbacks u
   WHERE EXISTS(SELECT 1 FROM inbox_reply_send.attempts a WHERE a.provider_reference=u.provider_reference)
   ORDER BY u.received_at LIMIT batch_limit
 LOOP
  scanned_count:=scanned_count+1;
  BEGIN
   IF (inbox_reply_send.drain_unmatched(r.provider,r.provider_reference)->>'drained')::boolean THEN
    drained_count:=drained_count+1;
   END IF;
  EXCEPTION WHEN OTHERS THEN
   failed_count:=failed_count+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('scanned',scanned_count,'drained',drained_count,'failed',failed_count);
END $$;

-- Service-role wrapper for the sweep, called from a cron route
-- (src/app/api/cron/inbox-reply-callback-sweep/route.ts) the same way the
-- Outbox's own cron route calls its reconciliation RPC — CRON_SECRET-gated
-- at the route layer, service-role at the DB layer, never a user session.
CREATE FUNCTION public.inbox_reply_sweep_unmatched_callbacks(batch_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='20s' AS $$
BEGIN
 RETURN inbox_reply_send.sweep_unmatched_callbacks(batch_limit);
END $$;
REVOKE ALL ON FUNCTION public.inbox_reply_sweep_unmatched_callbacks(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_reply_sweep_unmatched_callbacks(integer) TO service_role;

-- Public/service wrapper. Mirrors public-api.sql's SECURITY DEFINER idiom,
-- but granted to service_role only, never authenticated/anon — the caller
-- is the ingress route's admin client (no user session), not a signed-in
-- member. This is the ONLY service-role reach into inbox_reply_send (the
-- ledger revokes service_role wholesale at attempts.sql:508-514); it does
-- the org resolution + reserve/reconcile/store-unmatched atomically in one
-- transaction so there is no TOCTOU window between "who owns this
-- reference" and "did we already process this exact callback".
--
-- Reservation/completion is fenced by (lease_owner,lease_generation): this
-- call always mints a FRESH lease_owner and increments lease_generation
-- past whatever is currently stored, then only marks the row
-- processed/error if that exact (lease_owner,lease_generation) still owns
-- the row at completion time — a losing concurrent claim can never mark a
-- winner's row processed, and a stale retry can never re-open a completed
-- one.
CREATE FUNCTION public.inbox_reply_reconcile_callback(in_provider text,in_external_id text,in_terminal text,in_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE att_org uuid;in_event_type text;existing inbox_reply_send.callback_receipts;my_owner uuid:=gen_random_uuid();my_generation bigint;claimed boolean:=false;result jsonb;completed integer;
BEGIN
 IF in_provider IS DISTINCT FROM 'sendillo' OR in_external_id IS NULL OR btrim(in_external_id)='' OR octet_length(in_external_id)>512 OR in_terminal NOT IN ('delivered','delivery_failed') OR jsonb_typeof(in_payload) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'INBOX_REPLY_INVALID_CALLBACK';
 END IF;
 in_event_type:='inbox_reply_status_'||in_terminal;

 SELECT a.org_id INTO att_org FROM inbox_reply_send.attempts a WHERE a.provider_reference=in_external_id;
 IF NOT FOUND THEN
  INSERT INTO inbox_reply_send.unmatched_callbacks AS u(provider,provider_reference,terminal_status,payload)
   VALUES(in_provider,in_external_id,in_terminal,in_payload) ON CONFLICT (provider,provider_reference) DO NOTHING;
  RETURN jsonb_build_object('kind','stored_unmatched');
 END IF;

 -- [Astra fix-1] Drain any EARLIER-held terminal for this SAME reference
 -- FIRST, before reserving/reconciling the CURRENT callback — so
 -- first-arrival wins regardless of persist() timing. Without this, a
 -- callback held before persist() (Astra #5) was never reconciled at all
 -- (drain_unmatched had no caller), and a genuinely later, different
 -- terminal arriving on the matched path would apply directly and
 -- contradict the held first arrival instead of the held one winning.
 -- unmatched_callbacks' PRIMARY KEY(provider,provider_reference) means at
 -- most one row can ever be held for this reference, so this is a single,
 -- targeted drain — never a broad sweep — and a no-op when nothing is held.
 PERFORM inbox_reply_send.drain_unmatched(in_provider,in_external_id);

 -- Reserve/claim, lease-fenced. Try the fast INSERT path first (first-ever
 -- delivery of this exact reply-namespaced event); fall back to a fenced
 -- reclaim only on conflict.
 BEGIN
  INSERT INTO inbox_reply_send.callback_receipts AS c(org_id,provider,event_type,external_id,processing_status,lease_owner,lease_generation,lease_until,payload)
   VALUES(att_org,in_provider,in_event_type,in_external_id,'processing',my_owner,0,clock_timestamp()+interval '5 minutes',in_payload);
  my_generation:=0;claimed:=true;
 EXCEPTION WHEN unique_violation THEN
  SELECT * INTO existing FROM inbox_reply_send.callback_receipts c WHERE c.provider=in_provider AND c.event_type=in_event_type AND c.external_id=in_external_id FOR UPDATE;
  IF NOT FOUND THEN RAISE; END IF;
  IF existing.processing_status='processed' THEN
   RETURN jsonb_build_object('kind','already_processed');
  ELSIF existing.processing_status='processing' AND existing.lease_until>clock_timestamp() THEN
   RETURN jsonb_build_object('kind','busy');
  ELSE
   my_generation:=existing.lease_generation+1;
   UPDATE inbox_reply_send.callback_receipts AS c
    SET processing_status='processing',lease_owner=my_owner,lease_generation=my_generation,lease_until=clock_timestamp()+interval '5 minutes',payload=in_payload,error_message=NULL
    WHERE c.provider=in_provider AND c.event_type=in_event_type AND c.external_id=in_external_id
      AND c.lease_generation=existing.lease_generation;
   GET DIAGNOSTICS completed=ROW_COUNT;
   IF completed<>1 THEN RETURN jsonb_build_object('kind','busy');END IF;
   claimed:=true;
  END IF;
 END;
 IF NOT claimed THEN RETURN jsonb_build_object('kind','busy');END IF;

 BEGIN
  result:=inbox_reply_send.reconcile_delivery(att_org,in_provider,in_external_id,in_terminal,in_payload);
  UPDATE inbox_reply_send.callback_receipts AS c
   SET processing_status='processed',processed_at=clock_timestamp()
   WHERE c.provider=in_provider AND c.event_type=in_event_type AND c.external_id=in_external_id
     AND c.lease_owner=my_owner AND c.lease_generation=my_generation;
  RETURN jsonb_build_object('kind','reconciled','result',result);
 EXCEPTION WHEN OTHERS THEN
  UPDATE inbox_reply_send.callback_receipts AS c
   SET processing_status='error',processed_at=clock_timestamp(),error_message=left(SQLERRM,256)
   WHERE c.provider=in_provider AND c.event_type=in_event_type AND c.external_id=in_external_id
     AND c.lease_owner=my_owner AND c.lease_generation=my_generation;
  -- [Astra fix-1, correctness] A KNOWN business-rule rejection on the
  -- CURRENT callback (most importantly INBOX_REPLY_CONTRADICTORY_RECEIPT,
  -- when the drain-first step above already applied an earlier-held
  -- terminal as the real winner) must NOT re-raise here: re-raising would
  -- abort this whole function's transaction, which would UNDO the
  -- drain-first step's already-correct write along with it — durably
  -- stranding the held first-arrival every time a losing later callback
  -- retries (a livelock: the provider's webhook retry would replay this
  -- exact losing callback forever, never letting the winning drain
  -- persist). Returning a normal, non-raising 'rejected' result instead
  -- lets THIS statement's failure roll back to its own savepoint (this
  -- BEGIN block) while the drain's writes, already part of the SAME
  -- outer transaction, commit normally when the function returns. Any
  -- OTHER, unrecognized error still re-raises — genuinely unexpected
  -- failures (constraint violations, connectivity) must still abort loudly.
  IF SQLERRM IN ('INBOX_REPLY_CONTRADICTORY_RECEIPT','INBOX_REPLY_CALLBACK_UNMATCHED','INBOX_REPLY_INVALID_PERSIST_TRANSITION') THEN
   RETURN jsonb_build_object('kind','rejected','code',SQLERRM);
  END IF;
  RAISE;
 END;
END $$;
REVOKE ALL ON FUNCTION public.inbox_reply_reconcile_callback(text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_reply_reconcile_callback(text,text,text,jsonb) TO service_role;

DO $$ DECLARE t record;BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='inbox_reply_send' AND tablename IN ('unmatched_callbacks','callback_receipts') LOOP EXECUTE format('ALTER TABLE inbox_reply_send.%I ENABLE ROW LEVEL SECURITY',t.tablename);END LOOP;END $$;
REVOKE ALL ON inbox_reply_send.unmatched_callbacks,inbox_reply_send.callback_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION inbox_reply_send.reconcile_delivery(uuid,text,text,text,jsonb),inbox_reply_send.drain_unmatched(text,text),inbox_reply_send.sweep_unmatched_callbacks(integer) FROM PUBLIC;
DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON inbox_reply_send.unmatched_callbacks,inbox_reply_send.callback_receipts FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON FUNCTION inbox_reply_send.reconcile_delivery(uuid,text,text,text,jsonb),inbox_reply_send.drain_unmatched(text,text),inbox_reply_send.sweep_unmatched_callbacks(integer) FROM %I',r.rolname);
 END LOOP;
END $$;



-- Pinned reply_public_api: experiments/inbox-reply-send/public-api.sql
-- source_sha256=4d5e1c7d76bd3464ca12c68d0a173bc6a58c3bc1e743d2e6f69b0b57da79fe0e
-- Lane 1 PR-E: public SECURITY DEFINER wrappers for accept/recover/status.
-- Mirrors experiments/inbox-reply-review/public-api.sql's idiom exactly:
-- identity (org_id/user_id) is derived from the caller's JWT/session via
-- inbox_action_api.authorize(NULL), never accepted as a caller-supplied
-- parameter. Gated on inbox_reply_review.require_admission() (the SAME
-- switch PR-D's claim()/start_dispatch() already gate on), so accept/
-- recover stay inert while admission is closed — identical to the flag
-- being off entirely.

DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;
END $$;

CREATE FUNCTION public.inbox_accept_reply(preparation_id uuid,idempotency_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb;
BEGIN
 a:=inbox_action_api.authorize(NULL);
 RETURN inbox_reply_send.accept((a->>'org_id')::uuid,(a->>'user_id')::uuid,idempotency_key,preparation_id);
END $$;

CREATE FUNCTION public.inbox_recover_reply(preparation_id uuid,idempotency_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb;
BEGIN
 a:=inbox_action_api.authorize(NULL);
 RETURN inbox_reply_send.recover((a->>'org_id')::uuid,(a->>'user_id')::uuid,idempotency_key,preparation_id);
END $$;

-- Deliberately NOT admission-gated (matches inbox_operation_status /
-- start_dispatch/persist's own not-gated read/reconcile paths): an
-- operation already accepted must remain readable by its own requester even
-- if admission is later flipped closed, so status never drifts from what
-- accept() already committed.
CREATE FUNCTION public.inbox_reply_operation_status(operation_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb;
BEGIN
 a:=inbox_action_api.authorize(NULL);
 -- Org-scoped (like inbox_operation_status), not requester-scoped: any
 -- currently-authorized member of the operation's own org may read status,
 -- matching the metadata lane's status endpoint. inbox_reply_send.operation_status
 -- itself raises INBOX_REPLY_OPERATION_UNAVAILABLE (42501) for any
 -- operation not in this org.
 RETURN inbox_reply_send.operation_status((a->>'org_id')::uuid,operation_id);
END $$;

REVOKE ALL ON FUNCTION public.inbox_accept_reply(uuid,uuid),public.inbox_recover_reply(uuid,uuid),public.inbox_reply_operation_status(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_accept_reply(uuid,uuid),public.inbox_recover_reply(uuid,uuid),public.inbox_reply_operation_status(uuid) TO authenticated;



-- Pinned reply_worker: experiments/inbox-reply-send-worker/worker.sql
-- source_sha256=a4c4a5229a74a538addeec29e153e4633c1c3dbf2bd5e91cc5fa1f28a475486c
-- Lane 1 PR-F: durable reply-send worker SQL surface. Additive only — does NOT
-- touch attempts.sql or accept.sql (PR-D/PR-E are frozen). Every function here
-- is SECURITY DEFINER and is one of the EIGHT things granted to the dedicated
-- inbox_reply_send_worker role (worker-role.sql): claim_dispatch_batch,
-- ack_dispatch, operation_dispatch_complete, operation_attempts, worker_claim,
-- worker_start_dispatch (which folds the requester re-authorization check in —
-- see its own header below), worker_persist. The role never gets a direct
-- table grant or EXECUTE on attempts.sql's plain (non-DEFINER)
-- claim()/start_dispatch()/persist() themselves — those stay reachable only
-- from inside a SECURITY DEFINER wrapper here, exactly like
-- inbox_action_api.run_step wraps inbox_operations.claim_step/execute_step
-- (experiments/inbox-operation-preparation/worker.sql:72-87) without exposing
-- them directly.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;
END $$;

-- Outbox claim/ack. Byte-identical fencing to
-- inbox_action_api.claim_dispatch_batch/ack_dispatch
-- (experiments/inbox-operation-preparation/worker.sql:95-106), schema-swapped
-- onto inbox_reply_send.dispatch_outbox (PR-E, byte-identical outbox shape —
-- no schema gap). The outbox event ID is the durable-engine idempotency key;
-- a dispatcher only acknowledges after the engine accepts the invocation
-- durably, and only once EVERY attempt of the operation is
-- dispatched-or-terminal (operation_dispatch_complete below — Astra #4
-- ack-readiness). Lost responses leave the lease to expire and redeliver the
-- same immutable event identity.
CREATE FUNCTION inbox_reply_send.claim_dispatch_batch(batch_size integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Invalid dispatch bound';END IF;
 WITH candidates AS(SELECT d.org_id,d.operation_id FROM inbox_reply_send.dispatch_outbox d WHERE d.acknowledged_at IS NULL AND (d.lease_until IS NULL OR d.lease_until<=clock_timestamp()) ORDER BY d.created_at,d.event_id LIMIT batch_size FOR UPDATE SKIP LOCKED), claimed AS(
  UPDATE inbox_reply_send.dispatch_outbox d SET generation=d.generation+1,lease_until=clock_timestamp()+interval '30 seconds' FROM candidates c WHERE d.org_id=c.org_id AND d.operation_id=c.operation_id RETURNING d.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('org_id',org_id,'operation_id',operation_id,'event_id',event_id,'generation',generation::text) ORDER BY event_id),'[]') INTO result FROM claimed;
 RETURN result;
END $$;

-- [Astra #4, ack-readiness] Net-new gate absent from the metadata worker's own
-- ack_dispatch: this operation's outbox row is acknowledgeable ONLY when NO
-- attempt is still in {approved,claimed,dispatch_started}. 'uncertain' counts
-- as dispatched-awaiting-callback — the DISPATCH job is done; PR-G's callback
-- lifecycle (uncertain -> provider_accepted, provider_accepted -> delivered/
-- delivery_failed) is a separate concern this worker does not drive. An
-- operation with zero attempts (every item ineligible at accept time) is
-- vacuously complete and acks on the very first pass.
CREATE FUNCTION inbox_reply_send.operation_dispatch_complete(o uuid,op uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT EXISTS(SELECT 1 FROM inbox_reply_send.attempts a WHERE a.org_id=o AND a.operation_id=op AND a.state IN ('approved','claimed','dispatch_started'))
$$;

CREATE FUNCTION inbox_reply_send.ack_dispatch(o uuid,op uuid,g bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT inbox_reply_send.operation_dispatch_complete(o,op) THEN RETURN false;END IF;
 UPDATE inbox_reply_send.dispatch_outbox SET acknowledged_at=clock_timestamp(),lease_until=NULL WHERE org_id=o AND operation_id=op AND generation=g AND acknowledged_at IS NULL AND lease_until>clock_timestamp();
 RETURN FOUND;
END $$;

-- Net-new enumerator the Restate handler iterates (one ctx.run per attempt).
-- Returns each item's CURRENT (tip-of-chain) attempt id only: a row with a
-- successor (prior_attempt_id pointing back to it) is a retired retry
-- predecessor, always already terminal (D-6(1)'s live-attempt partial unique
-- guarantees at most one non-terminal row per item, and only
-- confirmed_not_submitted/rejected_unsent rows may have a successor at all —
-- attempts.sql:129-134), so it is correctly excluded here: there is nothing
-- left for the worker to do with a row that already has a fresher successor.
-- Stable order: (attempt_ordinal, item_id).
CREATE FUNCTION inbox_reply_send.operation_attempts(o uuid,op uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT a.id FROM inbox_reply_send.attempts a
 WHERE a.org_id=o AND a.operation_id=op
   AND NOT EXISTS(SELECT 1 FROM inbox_reply_send.attempts s WHERE s.org_id=o AND s.prior_attempt_id=a.id)
 ORDER BY a.attempt_ordinal,a.item_id
$$;

-- Thin SECURITY DEFINER pass-through onto attempts.sql's plain (invoker-
-- rights) claim() — attempts.sql is frozen (do not touch), and claim() was
-- deliberately left non-SECURITY-DEFINER there (D-9 header: "No public API,
-- no route, no worker"). Wrapping here, rather than granting the worker role
-- direct table privileges or EXECUTE on the raw function, keeps the worker's
-- reachable surface bounded (worker-role.sql enforces the exact list at
-- install time).
CREATE FUNCTION inbox_reply_send.worker_claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_reply_send.claim(o,attempt_id,seconds) $$;

-- [Astra B1, fixing the original Astra #3 finding] Requester re-authorization
-- FOLDED INTO the same transaction/statement as the ledger start_dispatch
-- call — not a separate prior statement whose locks release before the
-- marker. The original design (a standalone worker_authorize() call before
-- start_dispatch, and — worse — one that fabricated a browser session via
-- request.jwt.claims) had two real defects: (1) its FOR SHARE lock on the
-- access-epoch row was released the instant that statement committed, wide
-- open to a revocation committing in the gap before start_dispatch's own
-- marker write; (2) a background worker inventing a session claims object is
-- the wrong shape entirely — a worker holds no bearer token and must not
-- synthesize one, and worker_authorize was trivially skippable (nothing
-- forced runner.mjs to call it before start_dispatch; it was just a second,
-- separate, un-fenced RPC).
--
-- This function instead:
--  1. Resolves the attempt's operation and the operation's requester_id
--     (never a caller-supplied identity).
--  2. Takes the SAME access-epoch row inbox_bridge.authorize's own
--     authorize() check takes, FOR SHARE, FIRST — inbox_bridge.
--     capture_access() (inbox-workset-bridge/auth.sql:7-19) fires on every
--     memberships UPDATE and does an INSERT..ON CONFLICT DO UPDATE against
--     this exact row, which requires a conflicting row lock. Holding FOR
--     SHARE here means any concurrent membership revocation for this
--     requester now serializes behind THIS transaction — it cannot commit
--     until this function (and the start_dispatch call it makes, in the SAME
--     transaction, further below) has committed or rolled back. There is no
--     window between "check passes" and "marker written" for a revocation to
--     land unnoticed, because the epoch lock is held THROUGH the marker.
--  3. Checks the requester's CURRENT membership directly, using the exact
--     predicate inbox_bridge.authorize uses (auth.sql:31-34): active,
--     not pending deletion, not expired, for the operation's own org. No
--     session, no JWT, no request.jwt.claims fabrication — this is a direct,
--     server-side membership read, exactly the shape a background worker
--     should use.
--  4. Only on success does it call inbox_reply_send.start_dispatch — in the
--     SAME function invocation, i.e. the SAME statement-level transaction —
--     so the epoch lock from step 2 is still held while the marker commits.
-- A revoked/expired/foreign-org membership, or a forged operation/attempt
-- relationship (attempt not found, or operation not found for org o), raises
-- 42501 and start_dispatch is never called — no token, no provider call.
-- [Astra round-2 B1] The pre-check above is fail-fast only — it is NOT the
-- authoritative gate. inbox_reply_send.start_dispatch() itself can BLOCK for
-- an unbounded time: item_current() takes FOR SHARE on the sender/head rows,
-- and the marker UPDATE itself can wait on the D-6(5) sender-inflight unique
-- index. A requester's access_expires_at can lapse DURING that wait — the
-- exact same "last-eligibility-read-after-the-last-statement-that-can-wait"
-- shape PR-D's own R3-2/R3-1 invariant exists to close for eligibility, now
-- applied to requester authorization. So: capture start_dispatch's result,
-- and — ONLY if it actually wrote the marker ({kind:'dispatch'}; a
-- 'skipped' result changed nothing that needs unwinding) — re-check the
-- SAME membership predicate with a FRESH clock_timestamp() AFTER
-- start_dispatch returns. A lapsed/revoked/foreign-org membership at THAT
-- point raises 42501, which aborts this ENTIRE function's transaction —
-- including start_dispatch's own marker UPDATE, which is not yet committed
-- (this whole function is one top-level statement/transaction) — so the
-- attempt rolls back to 'claimed', dispatch_started_at/dispatch_token are
-- never persisted, and no provider call is possible.
CREATE FUNCTION inbox_reply_send.worker_start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op uuid;requester uuid;active boolean;result jsonb;
BEGIN
 SELECT a.operation_id INTO op FROM inbox_reply_send.attempts a WHERE a.org_id=o AND a.id=attempt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_UNAVAILABLE';END IF;
 SELECT r.requester_id INTO requester FROM inbox_reply_send.operations r WHERE r.org_id=o AND r.id=op;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_OPERATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=requester FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_ACCESS_BASELINE_MISSING' USING ERRCODE='42501';END IF;
 SELECT EXISTS(
  SELECT 1 FROM public.memberships m
  WHERE m.user_id=requester AND m.org_id=o AND m.access_status='active' AND m.deletion_prepared_at IS NULL
   AND (m.access_expires_at IS NULL OR m.access_expires_at>clock_timestamp())
 ) INTO active;
 IF NOT active THEN RAISE EXCEPTION 'INBOX_REPLY_REQUESTER_UNAUTHORIZED' USING ERRCODE='42501';END IF;
 result:=inbox_reply_send.start_dispatch(o,attempt_id,g);
 IF result->>'kind'='dispatch' THEN
  SELECT EXISTS(
   SELECT 1 FROM public.memberships m
   WHERE m.user_id=requester AND m.org_id=o AND m.access_status='active' AND m.deletion_prepared_at IS NULL
    AND (m.access_expires_at IS NULL OR m.access_expires_at>clock_timestamp())
  ) INTO active;
  IF NOT active THEN RAISE EXCEPTION 'INBOX_REPLY_REQUESTER_UNAUTHORIZED' USING ERRCODE='42501';END IF;
 END IF;
 RETURN result;
END $$;

CREATE FUNCTION inbox_reply_send.worker_persist(o uuid,attempt_id uuid,token uuid,result jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_reply_send.persist(o,attempt_id,token,result) $$;

-- [Astra B3] operation_dispatch_complete is called directly by the Restate
-- handler (server.mjs) to decide whether to ack — it is NOT merely an
-- internal helper for ack_dispatch, and must be granted. The worker's
-- reachable surface is EIGHT functions, not seven.
REVOKE ALL ON FUNCTION inbox_reply_send.claim_dispatch_batch(integer),inbox_reply_send.ack_dispatch(uuid,uuid,bigint),inbox_reply_send.operation_dispatch_complete(uuid,uuid),inbox_reply_send.operation_attempts(uuid,uuid),inbox_reply_send.worker_claim(uuid,uuid,integer),inbox_reply_send.worker_start_dispatch(uuid,uuid,bigint),inbox_reply_send.worker_persist(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;



-- Pinned reply_worker_role: experiments/inbox-reply-send-worker/worker-role.sql
-- source_sha256=086f384ecb54a0966e16aa3d007cd767a73e3ba06faa120141c36926858de465
-- Dedicated role candidate for the reply-send worker. Mirrors
-- experiments/inbox-operation-preparation/worker-role.sql's inbox_action_worker
-- exactly, distinct role name and distinct (narrower) function allow-list —
-- EIGHT functions: claim_dispatch_batch, ack_dispatch,
-- operation_dispatch_complete [Astra B3 — the Restate handler calls this
-- directly to decide whether to ack, not merely internally from ack_dispatch],
-- operation_attempts, worker_claim, worker_start_dispatch (folds the
-- requester re-authorization check in, see worker.sql), worker_persist.
-- Nothing else. No password or LOGIN role is created here; credential/login
-- provisioning is a separate approved hosting operation.

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_reply_send_worker') THEN
  CREATE ROLE inbox_reply_send_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_reply_send_worker' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member='inbox_reply_send_worker'::regrole) THEN
  RAISE EXCEPTION 'Unexpected privileged reply-send worker role';
 END IF;
END $$;
REVOKE ALL ON SCHEMA inbox_reply_send,inbox_reply_review,inbox_reply_preparation,inbox_reply_context FROM inbox_reply_send_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_send,inbox_reply_review,inbox_reply_preparation,inbox_reply_context FROM inbox_reply_send_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_send,inbox_reply_review,inbox_reply_preparation,inbox_reply_context FROM inbox_reply_send_worker;
GRANT USAGE ON SCHEMA inbox_reply_send TO inbox_reply_send_worker;
GRANT EXECUTE ON FUNCTION
 inbox_reply_send.claim_dispatch_batch(integer),
 inbox_reply_send.ack_dispatch(uuid,uuid,bigint),
 inbox_reply_send.operation_dispatch_complete(uuid,uuid),
 inbox_reply_send.operation_attempts(uuid,uuid),
 inbox_reply_send.worker_claim(uuid,uuid,integer),
 inbox_reply_send.worker_start_dispatch(uuid,uuid,bigint),
 inbox_reply_send.worker_persist(uuid,uuid,uuid,jsonb)
 TO inbox_reply_send_worker;
-- Explicit REVOKE cannot subtract an inherited PUBLIC privilege. Refuse the
-- installation if canonical schema ACLs grant this principal broader authority
-- than the eight functions above.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND c.relkind IN ('r','p','v','m','f')
   AND has_schema_privilege('inbox_reply_send_worker',n.oid,'USAGE')
   AND has_table_privilege('inbox_reply_send_worker',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
  RAISE EXCEPTION 'Reply-send worker unexpectedly has direct data privileges';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND p.prosecdef AND p.prorettype<>'trigger'::regtype
   AND has_schema_privilege('inbox_reply_send_worker',n.oid,'USAGE')
   AND has_function_privilege('inbox_reply_send_worker',p.oid,'EXECUTE')
   AND p.oid<>ALL(ARRAY['inbox_reply_send.claim_dispatch_batch(integer)'::regprocedure,
    'inbox_reply_send.ack_dispatch(uuid,uuid,bigint)'::regprocedure,
    'inbox_reply_send.operation_dispatch_complete(uuid,uuid)'::regprocedure,
    'inbox_reply_send.operation_attempts(uuid,uuid)'::regprocedure,
    'inbox_reply_send.worker_claim(uuid,uuid,integer)'::regprocedure,
    'inbox_reply_send.worker_start_dispatch(uuid,uuid,bigint)'::regprocedure,
    'inbox_reply_send.worker_persist(uuid,uuid,uuid,jsonb)'::regprocedure]::oid[])) THEN
  RAISE EXCEPTION 'Reply-send worker unexpectedly reaches another privileged function';
 END IF;
END $$;



-- Release overlay: session authority stays available for status/recovery while
-- new command families require server-derived actor/org admission.
CREATE OR REPLACE FUNCTION public.inbox_prepare_action(canonical_input text,idempotency_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_prepare');
 RETURN inbox_action_api.prepare_review(canonical_input,idempotency_key);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_accept_action(preparation_id uuid,idempotency_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_accept');
 RETURN inbox_action_api.accept(preparation_id,idempotency_key);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_capture_reply_recipients(conversation_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('reply_prepare');
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.capture(conversation_ids);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_freeze_reply_review(canonical_input text,idempotency_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('reply_prepare');
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.freeze(canonical_input,idempotency_key);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_reply_source_context(source_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('reply_prepare');
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.source_context(source_operation_id);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_accept_reply(preparation_id uuid,idempotency_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb;
BEGIN
 PERFORM inbox_control.admit_command('reply_accept');
 a:=inbox_action_api.authorize(NULL);
 RETURN inbox_reply_send.accept((a->>'org_id')::uuid,(a->>'user_id')::uuid,idempotency_key,preparation_id);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_saved_action_create(name text,definition jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_saved_write');
 RETURN inbox_saved_actions.create_for_session(name,definition);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_saved_action_update(id uuid,name text,definition jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_saved_write');
 RETURN inbox_saved_actions.update_for_session(id,name,definition);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_saved_action_deactivate(id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_saved_write');
 RETURN inbox_saved_actions.deactivate_for_session(id);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_saved_action_list() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_saved_read');
 RETURN inbox_saved_actions.list_for_session();
END $$;
CREATE OR REPLACE FUNCTION public.inbox_saved_action_get(id uuid,version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_saved_read');
 RETURN inbox_saved_actions.get_for_session(id,version);
END $$;
REVOKE ALL ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_accept_action(uuid,uuid),public.inbox_capture_reply_recipients(uuid[]),public.inbox_freeze_reply_review(text,uuid),public.inbox_reply_source_context(uuid),public.inbox_accept_reply(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_accept_action(uuid,uuid),public.inbox_capture_reply_recipients(uuid[]),public.inbox_freeze_reply_review(text,uuid),public.inbox_reply_source_context(uuid),public.inbox_accept_reply(uuid,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.inbox_saved_action_create(text,jsonb),public.inbox_saved_action_update(uuid,text,jsonb),public.inbox_saved_action_deactivate(uuid),public.inbox_saved_action_list(),public.inbox_saved_action_get(uuid,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_saved_action_create(text,jsonb),public.inbox_saved_action_update(uuid,text,jsonb),public.inbox_saved_action_deactivate(uuid),public.inbox_saved_action_list(),public.inbox_saved_action_get(uuid,integer) TO authenticated;

COMMIT;
