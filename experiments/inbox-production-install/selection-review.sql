-- Release companion guard; apply after the core read schema and maintained rows exist.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'sandra_inbox_release_20260917' OR NOT EXISTS(
  SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-release-owned-synthetic'
 ) THEN RAISE EXCEPTION 'Owned release fixture required'; END IF;
END $$;
-- Reviewed read companion; install after inbox_read and serving authorization.
-- Selection classification uses the workset predicate on at most 100 requested
-- maintained rows. It never loads the complete matching workset.
CREATE OR REPLACE FUNCTION inbox_read.review_selection(o uuid,f jsonb,targets jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb; after_access jsonb; u uuid; result jsonb; target jsonb;
BEGIN
 a:=inbox_bridge.authorize_serving(o);u:=(a->>'user_id')::uuid;
 f:=inbox_bridge.normalize_filter(f);
 IF jsonb_typeof(targets) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(targets)<1 OR jsonb_array_length(targets)>100 THEN
  RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';
 END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(targets) LOOP
  IF jsonb_typeof(target) IS DISTINCT FROM 'object' OR
   (target-ARRAY['kind','id'])<>'{}'::jsonb OR
   jsonb_typeof(target->'kind') IS DISTINCT FROM 'string' OR
   target->>'kind' NOT IN ('conversation','unknown_sender_group') OR
   jsonb_typeof(target->'id') IS DISTINCT FROM 'string' OR
   (target->>'id') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
   RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';
  END IF;
 END LOOP;
 IF (SELECT count(DISTINCT (value->>'kind',value->>'id')) FROM jsonb_array_elements(targets))<>jsonb_array_length(targets) THEN
  RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';
 END IF;
 WITH requested AS MATERIALIZED (
  SELECT value->>'kind' kind,(value->>'id')::uuid id,ordinal,
   CASE value->>'kind' WHEN 'conversation' THEN 'known_conversation' ELSE 'unknown_sender' END target_kind
  FROM jsonb_array_elements(targets) WITH ORDINALITY t(value,ordinal)
 ), p AS (SELECT f->>'view' AS view,(f->>'hide_noise')::boolean AS hide_noise,f->>'search' AS q),
 candidates AS MATERIALIZED (
  SELECT r.target_kind,r.target_id,r.summary s
  FROM requested t JOIN inbox_maintained.rows r ON r.org_id=o AND r.target_kind=t.target_kind AND r.target_id=t.id
  WHERE coalesce((r.summary->>'exists')::boolean,false)
  AND CASE WHEN t.kind='conversation' THEN EXISTS(SELECT 1 FROM public.messages m
    WHERE m.org_id=o AND m.conversation_id=t.id AND m.channel='sms')
   ELSE EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=o AND m.channel='sms'
    AND m.direction='inbound' AND m.contact_id IS NULL AND m.from_address<>''
    AND md5(m.from_address)=md5(r.summary->>'raw_sender_key')
    AND m.from_address=r.summary->>'raw_sender_key') END
 ), matching AS (
  SELECT c.target_kind,c.target_id FROM candidates c CROSS JOIN p
-- BEGIN canonical workset matching predicate
 WHERE CASE WHEN c.target_kind='unknown_sender' THEN
  -- Existing unknown loader does not consume known-conversation search input.
  CASE p.view WHEN 'active' THEN coalesce((c.s->>'visible_unknown')::boolean,false) WHEN 'unknown' THEN coalesce((c.s->>'visible_unknown')::boolean,false) WHEN 'dismissed' THEN coalesce((c.s->>'visible_dismissed')::boolean,false) ELSE false END
 ELSE
  CASE p.view WHEN 'unknown' THEN false WHEN 'dismissed' THEN false
   WHEN 'dispo' THEN (c.s->>'ai_disposition_review_id') IS NOT NULL AND NOT coalesce((c.s->>'is_test_traffic')::boolean,false)
   ELSE coalesce((c.s->>'has_recent')::boolean,false) AND (NOT p.hide_noise OR NOT coalesce((c.s->>'is_noise')::boolean,false)) AND
    CASE p.view WHEN 'mine' THEN c.s->>'property_status' IS NOT NULL AND c.s->>'property_status'<>'prospect' AND c.s->>'assigned_user_id'=u::text
     WHEN 'unassigned' THEN c.s->>'property_status' IS NOT NULL AND c.s->>'property_status'<>'prospect' AND c.s->>'assigned_user_id' IS NULL
     WHEN 'unread' THEN coalesce((c.s->>'unread_count')::bigint,0)>0
     WHEN 'escalated' THEN c.s->>'ai_responder_status'='escalated'
     WHEN 'needs_outcome' THEN coalesce((c.s->>'needs_outcome')::boolean,false)
     ELSE true END END
  AND (p.q IS NULL OR EXISTS(SELECT 1 FROM public.contacts ct WHERE ct.id=(c.s->>'contact_id')::uuid AND ct.org_id=o AND
    (ct.search_text ILIKE '%'||replace(replace(replace(lower(p.q),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%' ESCAPE E'\\'
    OR (length(regexp_replace(p.q,'[^0-9]','','g'))>=3 AND ct.phone_digits ILIKE '%'||regexp_replace(p.q,'[^0-9]','','g')||'%')))
   OR EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=o AND m.conversation_id=c.target_id AND m.channel='sms' AND m.fts @@ public.search_prefix_tsquery(p.q)))
 END
-- END canonical workset matching predicate
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',t.kind,'id',t.id,
  'status',CASE WHEN c.target_id IS NULL THEN 'unavailable' WHEN m.target_id IS NULL THEN 'outside_filter' ELSE 'matching' END,
  'name',CASE WHEN c.target_id IS NULL THEN NULL ELSE left(coalesce(nullif(c.s->>'contact_name',''),nullif(c.s->>'thread_customer_phone',''),nullif(c.s->>'raw_sender_key',''),'Conversation'),2000) END)
  ORDER BY t.ordinal),'[]'::jsonb) INTO result
 FROM requested t LEFT JOIN candidates c ON c.target_kind=t.target_kind AND c.target_id=t.id
 LEFT JOIN matching m ON m.target_kind=t.target_kind AND m.target_id=t.id;
 after_access:=inbox_bridge.authorize_serving(o);
 IF (after_access->>'user_id',after_access->>'session_id',after_access->>'access_epoch') IS DISTINCT FROM
  (a->>'user_id',a->>'session_id',a->>'access_epoch') THEN
  RAISE EXCEPTION 'INBOX_ORG_DENIED' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object('org_id',o,'requester_id',a->>'user_id','session_id',a->>'session_id',
  'access_epoch',a->>'access_epoch','items',result);
END $$;
REVOKE ALL ON FUNCTION inbox_read.review_selection(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.inbox_review_selection(org_id uuid,filter jsonb,targets jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=''
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
 SELECT inbox_read.review_selection(org_id,filter,targets)
$$;
REVOKE ALL ON FUNCTION public.inbox_review_selection(uuid,jsonb,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_review_selection(uuid,jsonb,jsonb) TO authenticated;

COMMIT;
