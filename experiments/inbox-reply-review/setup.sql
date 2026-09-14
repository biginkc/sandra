-- Owned candidate: authenticated capture and immutable reviewed literal bodies.
-- The application renders templates between capture and freeze. Rendered bodies
-- are user-authored message intent; routes and eligibility are always canonical.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF; END $$;
CREATE SCHEMA inbox_reply_review AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_reply_review FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_reply_review.preparations(
 id uuid PRIMARY KEY,org_id uuid NOT NULL,requester_id uuid NOT NULL,request_key uuid NOT NULL,
 input_hash text NOT NULL,canonical_input text NOT NULL,items jsonb NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,requester_id,request_key)
);
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
  'recipientCount',n,'blockers',to_jsonb(array_remove(ARRAY[CASE WHEN n=0 THEN 'empty' END,CASE WHEN n>50 THEN 'recipient_limit' END,CASE WHEN duplicates THEN 'duplicate_destination' END],NULL))) FROM counts
$$;
CREATE FUNCTION inbox_reply_review.freeze(raw_input text,k uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE a jsonb;o uuid;u uuid;input jsonb;target jsonb;draft jsonb;capture jsonb;item jsonb;items jsonb:='[]';ids uuid[];captures jsonb;found_count integer;reason text;duplicates text[];hash text;existing inbox_reply_review.preparations;prep inbox_reply_review.preparations;expires timestamptz;at_time timestamptz;
BEGIN
 IF k IS NULL OR raw_input IS NULL OR octet_length(raw_input)>2097152 THEN RAISE EXCEPTION 'Invalid bounded reply preparation';END IF;
 PERFORM inbox_action_api.assert_json_shape(raw_input::json);input:=raw_input::jsonb;
 IF jsonb_typeof(input) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(input))<>2 OR NOT(input ?& ARRAY['targets','drafts']) OR jsonb_typeof(input->'targets') IS DISTINCT FROM 'array' OR jsonb_array_length(input->'targets') NOT BETWEEN 1 AND 500 OR jsonb_typeof(input->'drafts') IS DISTINCT FROM 'array' OR jsonb_array_length(input->'drafts')>500 THEN RAISE EXCEPTION 'Invalid reply envelope';END IF;
 a:=inbox_action_api.authorize(NULL);o:=(a->>'org_id')::uuid;u:=(a->>'user_id')::uuid;
 PERFORM inbox_action_api.lock_request_key(o,u,k);
 hash:=encode(sha256(convert_to('sandra:inbox:reply:v1','utf8')||decode('00','hex')||convert_to(raw_input,'utf8')),'hex');
 SELECT * INTO existing FROM inbox_reply_review.preparations WHERE org_id=o AND requester_id=u AND request_key=k;
 IF FOUND THEN
  IF existing.input_hash<>hash OR existing.canonical_input<>raw_input THEN RAISE EXCEPTION 'INBOX_REPLY_IDEMPOTENCY_MISMATCH';END IF;
  PERFORM inbox_action_api.authorize(o,u);
  RETURN inbox_reply_review.view(existing);
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
 INSERT INTO inbox_reply_review.preparations(id,org_id,requester_id,request_key,input_hash,canonical_input,items,expires_at) VALUES(gen_random_uuid(),o,u,k,hash,raw_input,items,expires) RETURNING * INTO prep;
 RETURN inbox_reply_review.view(prep);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_review FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_review FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
