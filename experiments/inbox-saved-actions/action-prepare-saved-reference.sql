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
BEGIN;

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
 property_ids uuid[];enrollment_ids uuid[];row record;prep_id uuid:=gen_random_uuid();hash text;expires timestamptz:=clock_timestamp()+interval '5 minutes';exclusion text;has_sms boolean:=false;has_outcome boolean:=false;has_assignment boolean:=false;
BEGIN
 IF k IS NULL OR canonical_input IS NULL OR octet_length(canonical_input)>131072 THEN RAISE EXCEPTION 'Invalid action input';END IF;
 PERFORM inbox_action_api.assert_json_shape(canonical_input::json);
 intent:=canonical_input::jsonb;
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(intent))<>6 OR NOT(intent ?& ARRAY['purpose','organizationId','requesterId','targets','definition','savedAction']) OR intent->>'purpose' IS DISTINCT FROM 'prepare_action' OR inbox_action_api.invalid_saved_action_reference(intent->'savedAction') OR (SELECT count(*) FROM json_each(canonical_input::json))<>6 THEN RAISE EXCEPTION 'Invalid action envelope';END IF;
 o:=(intent->>'organizationId')::uuid;u:=(intent->>'requesterId')::uuid;
 IF o IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Invalid action actor';END IF;
 a:=inbox_action_api.authorize(o,u);
 definition:=intent->'definition';
 IF jsonb_typeof(definition) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(definition))<>2 OR definition->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(definition->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(definition->'steps') NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'Unsupported action definition';END IF;
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

REVOKE ALL ON FUNCTION inbox_action_api.invalid_saved_action_reference(jsonb),inbox_action_api.prepare(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
