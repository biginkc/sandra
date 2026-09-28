-- Metadata-operation follow-up context. This function is deliberately limited
-- to loading the accepted operation's immutable reply intent and original
-- target selection. The application then runs the normal reply capture,
-- renderer (including conditionals and OUTBOUND_SENDER_NAME), and freeze path.
-- No SQL-side template renderer or client-provided snapshot is trusted here.
BEGIN;

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
COMMIT;
