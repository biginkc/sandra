-- Authoritative metadata preparation candidate. Private fixture installation only.
BEGIN;
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
 a:=inbox_t2_bridge.authorize(o);
 PERFORM 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR SHARE;
 a:=inbox_t2_bridge.authorize(o);
 IF u IS NOT NULL AND a->>'user_id' IS DISTINCT FROM u::text THEN RAISE EXCEPTION 'INBOX_ACTION_FORBIDDEN' USING ERRCODE='42501';END IF;
 RETURN a;
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
  PERFORM inbox_t2_policy.validate_key(r->>'namespace',r->'key');
  INSERT INTO inbox_t2_policy.versions VALUES(o,r->>'namespace',(r->'key')::text,1) ON CONFLICT DO NOTHING;
 END LOOP;
 PERFORM 1 FROM inbox_t2_policy.versions v JOIN jsonb_array_elements(requirements) requirement_row ON v.namespace=requirement_row->>'namespace' AND v.entity_key=(requirement_row->'key')::text WHERE v.org_id=o ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
 RETURN inbox_t2_policy.snapshot(o,requirements);
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
    PERFORM 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=assignee FOR SHARE;
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
   resolved:=inbox_t2_summary_contract.compute(o,(target->>'id')::uuid,clock_timestamp());
   IF resolved->>'exists'='true' THEN
    INSERT INTO inbox_operation_domain.target_versions VALUES(o,(target->>'id')::uuid,1) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM inbox_operation_domain.target_versions WHERE org_id=o AND conversation_id=(target->>'id')::uuid FOR UPDATE;
    resolved:=inbox_t2_summary_contract.compute(o,(target->>'id')::uuid,clock_timestamp());
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
COMMIT;
