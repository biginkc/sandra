-- Personal saved-action definitions (DoD#3 backend). Immutable per-version
-- rows feeding the EXISTING `saved` seam in action-definition.ts
-- (parseInboxActionIntent's 3rd argument). No picker/builder UI, no
-- promotion, no unknown dismiss/restore here — those are separate pieces.
-- Mirrors inbox_action_api/inbox_operations idioms: private schema,
-- REVOKE ALL, org_id+requester_id in keys, immutable_row() trigger,
-- inbox_action_api.authorize(o,u) for membership, SECURITY DEFINER public
-- wrappers added in public-api.sql.
BEGIN;
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
-- outcome, assignment, promotion, and unknown-sender commands are wired to
-- the durable metadata executor. A final 'review_reply' is a hand-off to the
-- separate reply prepare/accept lane; it may follow a metadata prefix but is
-- never accepted or sent as part of that metadata operation. dnc stays
-- permanently gated off (matches inbox_action_api.prepare).
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
 IF EXISTS(SELECT 1 FROM unnest(types) t WHERE t NOT IN ('outcome','assign','promote','dismiss_unknown','restore_unknown','review_reply')) THEN
  RAISE EXCEPTION 'INBOX_SAVED_ACTION_STEP_TYPE_DISABLED';
 END IF;
 -- This mirrors action-definition.ts: metadata may contain one of each
 -- supported command, with outcome before assignment, and review_reply is an
 -- optional final hand-off. It is deliberately not limited to the old
 -- outcome/assign pair; saved definitions must use the same grammar as the
 -- inline prepare envelope.
 IF (SELECT count(*) FROM unnest(types) t WHERE t='outcome')>1
  OR (SELECT count(*) FROM unnest(types) t WHERE t='assign')>1
  OR (SELECT count(*) FROM unnest(types) t WHERE t='promote')>1
  OR (SELECT count(*) FROM unnest(types) t WHERE t IN ('dismiss_unknown','restore_unknown'))>1
  OR (SELECT count(*) FROM unnest(types) t WHERE t='review_reply')>1 THEN
  RAISE EXCEPTION 'INBOX_SAVED_ACTION_STEP_COMBINATION_UNSUPPORTED';
 END IF;
 IF 'review_reply'=ANY(types) AND types[array_length(types,1)]<>'review_reply' THEN
  RAISE EXCEPTION 'INBOX_SAVED_ACTION_STEP_COMBINATION_UNSUPPORTED';
 END IF;
 IF array_position(types,'assign') IS NOT NULL
  AND (array_position(types,'outcome') IS NULL OR array_position(types,'outcome')>array_position(types,'assign')
   OR (array_position(types,'promote') IS NOT NULL AND array_position(types,'promote')>array_position(types,'assign'))
   OR (array_position(types,'dismiss_unknown') IS NOT NULL AND array_position(types,'dismiss_unknown')>array_position(types,'assign'))
   OR (array_position(types,'restore_unknown') IS NOT NULL AND array_position(types,'restore_unknown')>array_position(types,'assign'))) THEN
  RAISE EXCEPTION 'INBOX_SAVED_ACTION_STEP_COMBINATION_UNSUPPORTED';
 END IF;
 IF array_position(types,'dismiss_unknown') IS NOT NULL AND array_position(types,'restore_unknown') IS NOT NULL THEN
  RAISE EXCEPTION 'INBOX_SAVED_ACTION_STEP_COMBINATION_UNSUPPORTED';
 END IF;
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
  ELSIF step->>'type' IN ('promote','dismiss_unknown','restore_unknown') THEN
   IF jsonb_typeof(step) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(step))<>1 OR NOT(step ? 'type') THEN RAISE EXCEPTION 'INBOX_SAVED_ACTION_INVALID_DEFINITION';END IF;
  ELSIF step->>'type'='review_reply' THEN
   IF jsonb_typeof(step) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(step))<>2 OR NOT(step ? 'text')
    OR jsonb_typeof(step->'text') IS DISTINCT FROM 'string' OR length(btrim(step->>'text')) NOT BETWEEN 1 AND 1600 THEN
    RAISE EXCEPTION 'INBOX_SAVED_ACTION_INVALID_DEFINITION';
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
COMMIT;
