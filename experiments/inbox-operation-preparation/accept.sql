-- Completes the private acceptance assertions using current canonical authority.
BEGIN;
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
   FROM inbox_t2_message_capture.sender_groups g
   WHERE g.org_id=prep.org_id AND g.sender_group_id=unknown_group
   FOR SHARE;
   IF unknown_raw IS NULL OR unknown_raw IS DISTINCT FROM unknown_snapshot->>'raw_sender' THEN
    RAISE EXCEPTION 'Unknown sender identity changed' USING ERRCODE='P0001';
   END IF;
   SELECT v.revision INTO revision
   FROM inbox_t2_message_capture.versions v
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
  PERFORM 1 FROM inbox_t2_policy.versions v JOIN jsonb_array_elements(requirements) r ON v.namespace=r->>'namespace' AND v.entity_key=(r->'key')::text WHERE v.org_id=prep.org_id ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
  IF inbox_t2_policy.snapshot(prep.org_id,requirements) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'INBOX_ACTION_PREPARATION_CHANGED';END IF;
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
COMMIT;
