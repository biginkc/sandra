-- Isolated private unknown-sender compute. No production migration or commands.
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres'
 OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic')
 THEN RAISE EXCEPTION 'Owned offline fixture required'; END IF;
END $$;
CREATE SCHEMA inbox_t2_unknown_summary AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_unknown_summary FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_t2_unknown_summary.compute(p_org uuid,p_raw_sender text,p_as_of timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 WITH eligible AS MATERIALIZED (
  SELECT id,from_address,to_address,body,created_at,dismissed_at
  FROM public.messages
  WHERE org_id=p_org AND from_address=p_raw_sender AND from_address<>''
    AND channel='sms' AND direction='inbound' AND contact_id IS NULL
  -- Deliberately no status/window/noise/suppression/property/conversation predicate.
 ), totals AS (
  SELECT count(*) AS message_count,
   count(*) FILTER(WHERE dismissed_at IS NULL) AS active_message_count,
   count(*) FILTER(WHERE dismissed_at IS NOT NULL) AS dismissed_message_count,
   max(created_at) AS latest_at FROM eligible
 ), latest AS MATERIALIZED (
  SELECT e.* FROM eligible e CROSS JOIN totals t WHERE e.created_at=t.latest_at
 ), identity AS (
  SELECT jsonb_build_object('target_kind','unknown_sender_group','org_id',p_org,
   'raw_sender_key',p_raw_sender,'sender_group_id',NULL,'identity_mapping_required',true,
   'as_of',p_as_of,'window_policy','all_eligible_history','next_window_expiry',NULL) AS value
 )
 SELECT i.value || CASE
  WHEN p_org IS NULL OR p_raw_sender IS NULL OR p_as_of IS NULL THEN jsonb_build_object('error','invalid_compute_scope')
  WHEN t.message_count=0 THEN jsonb_build_object('exists',false,'visible_unknown',false,'visible_dismissed',false,'message_count',0)
  ELSE (SELECT jsonb_build_object('exists',true,'latest_message_id',l.id,
    'latest_at',l.created_at,'latest_preview',left(l.body,120),'to_address',l.to_address,
    'latest_timestamp_tie_count',(SELECT count(*) FROM latest),
    'legacy_tie_parity_defined',(SELECT count(*) FROM latest)=1,
    'is_dismissed',l.dismissed_at IS NOT NULL,'visible_unknown',l.dismissed_at IS NULL,
    'visible_dismissed',l.dismissed_at IS NOT NULL,'message_count',t.message_count,
    'active_message_count',t.active_message_count,'dismissed_message_count',t.dismissed_message_count)
    FROM latest l ORDER BY l.id DESC LIMIT 1)
 END FROM totals t CROSS JOIN identity i;
$$;
-- This is a bounded proposal reader, NOT a persisted/frozen command workset.
-- Overflow returns no IDs so a caller cannot silently perform a partial group action.
CREATE FUNCTION inbox_t2_unknown_summary.propose_message_ids(p_org uuid,p_raw_sender text,p_action text,p_max integer DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 WITH eligible AS MATERIALIZED (
  SELECT id FROM public.messages
  WHERE org_id=p_org AND from_address=p_raw_sender AND from_address<>''
    AND channel='sms' AND direction='inbound' AND contact_id IS NULL
    AND CASE p_action WHEN 'dismiss' THEN dismissed_at IS NULL
                      WHEN 'restore' THEN dismissed_at IS NOT NULL ELSE false END
  ORDER BY id LIMIT least(greatest(coalesce(p_max,200),1),500)+1
 )
 SELECT CASE WHEN p_org IS NULL OR p_raw_sender IS NULL OR p_action IS NULL
   OR p_action NOT IN('dismiss','restore') OR p_max IS NULL OR p_max<1 OR p_max>500
 THEN jsonb_build_object('error','invalid_proposal_scope')
 ELSE jsonb_build_object('persisted',false,'complete',count(*)<=p_max,
   'status',CASE WHEN count(*)>p_max THEN 'requires_larger_workset' ELSE 'proposal_only' END,
   'message_ids',CASE WHEN count(*)<=p_max THEN coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) ELSE NULL END)
 END FROM eligible;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_unknown_summary FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
