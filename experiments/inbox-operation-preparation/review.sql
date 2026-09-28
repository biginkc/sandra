-- Additive review/recovery endpoints; no caller-supplied policy or identity.
BEGIN;
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
   AND EXISTS(SELECT 1 FROM inbox_t2_bridge.access_epochs e WHERE e.user_id=m.user_id)
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
COMMIT;
