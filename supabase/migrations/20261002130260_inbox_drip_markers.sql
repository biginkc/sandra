BEGIN;

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';

-- MARKERS follow-up.  This migration is deliberately read-only: it adds no
-- tables, columns, triggers, indexes, or data writes.

CREATE FUNCTION inbox_bridge.drip_flags(p_org_id uuid,p_property_id uuid)
RETURNS TABLE(drip_name text,drip_step integer,drip_steps_total integer,in_drip boolean,drip_replied boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT seq.name as drip_name,
   enrollment.current_step_index + 1 as drip_step,
   (select count(*)::integer from public.sequence_steps step
    where step.sequence_id = enrollment.sequence_id) as drip_steps_total,
   enrollment.status in ('active', 'paused') as in_drip,
   reply.latest_reply is not null and not exists (
     select 1 from public.messages action where action.org_id = p_org_id
       and action.property_id = p_property_id and action.direction = 'outbound'
       and action.status is distinct from 'failed'
       and action.campaign_id is null and action.metadata->>'generated_by' is null
       and action.created_at > reply.latest_reply
       and not exists (select 1 from public.sequence_step_runs r where r.message_id = action.id)
   ) and not exists (
     select 1 from public.acquisition_attempts attempt where attempt.org_id = p_org_id
       and attempt.property_id = p_property_id and attempt.recorded_at > reply.latest_reply
   ) and not exists (
     select 1 from public.lead_events event where event.org_id = p_org_id
       and event.property_id = p_property_id and event.actor_type = 'user'
       and event.created_at > reply.latest_reply
       and (event.event_type = 'dispo_set' or (event.event_type = 'my_leads_workflow'
         and event.payload->>'operation' in ('ready_acquisition_offer', 'log_acquisition_offer',
           'record_acquisition_contract', 'decline_acquisition_offer', 'handoff_acquisition_lead',
           'log_acquisition_attempt')))
   ) as drip_replied
 from public.sequence_enrollments enrollment
 join public.sequences seq on seq.id = enrollment.sequence_id and seq.org_id = enrollment.org_id
 left join lateral (
   select max(inbound.created_at) as latest_reply
   from public.messages inbound
   join lateral (
     select prior.id, prior.direction from public.messages prior
     where prior.org_id = p_org_id and prior.property_id = p_property_id
       and (prior.created_at, prior.id) < (inbound.created_at, inbound.id)
       and (prior.direction = 'inbound' or (prior.direction = 'outbound'
         and (prior.metadata->>'generated_by' is distinct from 'ai_responder_v1'
           or exists (select 1 from public.sequence_step_runs drip_run
             where drip_run.message_id = prior.id))))
     order by prior.created_at desc, prior.id desc limit 1
   ) prior on prior.direction = 'outbound'
   join public.sequence_step_runs run on run.message_id = prior.id
     and run.enrollment_id = enrollment.id
   where inbound.org_id = p_org_id and inbound.property_id = p_property_id
     and inbound.direction = 'inbound'
     and ((enrollment.status = 'paused' and enrollment.pause_reason in
       ('inbound_reply', 'rep_sms_human_takeover')) or enrollment.status = 'completed')
 ) reply on true
 where enrollment.property_id = p_property_id and enrollment.org_id = p_org_id
   and enrollment.status in ('active', 'paused', 'completed')
 order by case when enrollment.status in ('active', 'paused') then 0 else 1 end,
   enrollment.enrolled_at desc, enrollment.id desc
 limit 1
$$;

REVOKE ALL ON FUNCTION inbox_bridge.drip_flags(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.inbox_drip_markers_v1(org_id uuid,conversation_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb; after_access jsonb; result jsonb; as_of timestamptz:=statement_timestamp();
BEGIN
 a:=inbox_bridge.authorize_serving($1);
 IF $2 IS NULL OR (SELECT count(DISTINCT id)>500 FROM unnest($2) input(id)) OR
    EXISTS(SELECT 1 FROM unnest($2) id WHERE id IS NULL) THEN
   RAISE EXCEPTION 'INBOX_INVALID_MARKER_IDS' USING ERRCODE='22023';
 END IF;
 WITH requested AS MATERIALIZED (
   SELECT id,min(ordinal)::bigint AS ordinal
   FROM unnest($2) WITH ORDINALITY input(id,ordinal)
   GROUP BY id
 ), resolved AS MATERIALIZED (
   SELECT r.id,r.ordinal,(maintained.summary->>'property_id')::uuid AS property_id
   FROM requested r
   JOIN inbox_maintained.rows maintained
     ON maintained.org_id=$1
    AND maintained.target_kind='known_conversation'
    AND maintained.target_id=r.id
   WHERE coalesce((maintained.summary->>'exists')::boolean,false)
 ), computed AS (
   SELECT resolved.id,resolved.ordinal,resolved.property_id,
     coalesce(flags.in_drip,false) AS in_drip,
     coalesce(flags.drip_replied,false) AS drip_replied,
     CASE WHEN flags.in_drip OR flags.drip_replied THEN flags.drip_name END AS drip_name
   FROM resolved
   LEFT JOIN LATERAL inbox_bridge.drip_flags($1,resolved.property_id) flags ON true
 )
 SELECT jsonb_build_object(
   'org_id',$1,
   'as_of',as_of,
   'rows',coalesce((SELECT jsonb_agg(jsonb_build_object(
     'conversation_id',id,'property_id',property_id,'in_drip',in_drip,
     'drip_replied',drip_replied,'drip_name',drip_name
   ) ORDER BY ordinal) FROM computed),'[]'::jsonb)
 ) INTO result;
 after_access:=inbox_bridge.authorize_serving($1);
 IF (after_access->>'user_id',after_access->>'session_id',after_access->>'org_id',after_access->>'access_epoch') IS DISTINCT FROM
    (a->>'user_id',a->>'session_id',a->>'org_id',a->>'access_epoch') THEN
   RAISE EXCEPTION 'INBOX_ACCESS_CHANGED' USING ERRCODE='42501';
 END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.inbox_drip_markers_v1(uuid,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_drip_markers_v1(uuid,uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION inbox_bridge.normalize_filter(f jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE q text;
BEGIN
 IF f IS NULL OR jsonb_typeof(f)<>'object' OR (f-ARRAY['view','hide_noise','search'])<>'{}'::jsonb
 OR jsonb_typeof(f->'view') IS DISTINCT FROM 'string' OR f->>'view' NOT IN ('active','all','mine','unassigned','unread','escalated','dispo','needs_outcome','in_drip','drip_replied','unknown','dismissed')
 OR (f?'hide_noise' AND jsonb_typeof(f->'hide_noise') IS DISTINCT FROM 'boolean')
 OR (f?'search' AND jsonb_typeof(f->'search') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'INBOX_FILTER_INVALID' USING ERRCODE='22023';END IF;
 q:=left(btrim(coalesce(f->>'search','')),100);IF length(q)<3 THEN q:=NULL;END IF;
 RETURN jsonb_build_object('view',f->>'view','hide_noise',coalesce((f->>'hide_noise')::boolean,true),'search',q);
END $$;

CREATE OR REPLACE FUNCTION inbox_bridge.page(o uuid,u uuid,f jsonb,cursor_at timestamptz,cursor_kind text,cursor_id uuid,has_cursor boolean,n integer)
RETURNS TABLE(target_kind text,target_id uuid,latest_at timestamptz) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE predicate text;known text;query text;view_name text:=f->>'view';
BEGIN
 IF n IS NULL OR n<1 OR n>501 THEN RAISE EXCEPTION 'INBOX_PAGE_LIMIT';END IF;
 known:='r.target_kind=''known_conversation'' AND r.has_recent';
 IF (f->>'hide_noise')::boolean THEN known:=known||' AND NOT r.is_noise';END IF;
 CASE view_name
 WHEN 'all' THEN predicate:=known;
 WHEN 'mine' THEN predicate:=known||' AND r.assignable AND r.assigned_user_id=$2';
 WHEN 'unassigned' THEN predicate:=known||' AND r.assignable AND r.assigned_user_id IS NULL';
 WHEN 'unread' THEN predicate:=known||' AND r.unread';
 WHEN 'escalated' THEN predicate:=known||' AND r.escalated';
 WHEN 'needs_outcome' THEN predicate:=known||' AND r.needs_outcome';
 WHEN 'in_drip' THEN predicate:=known||' AND EXISTS(SELECT 1 FROM inbox_maintained.rows maintained LEFT JOIN LATERAL inbox_bridge.drip_flags($1,(maintained.summary->>''property_id'')::uuid) flags ON true WHERE maintained.org_id=$1 AND maintained.target_kind=r.target_kind AND maintained.target_id=r.target_id AND coalesce(flags.in_drip,false))';
 WHEN 'drip_replied' THEN predicate:=known||' AND EXISTS(SELECT 1 FROM inbox_maintained.rows maintained LEFT JOIN LATERAL inbox_bridge.drip_flags($1,(maintained.summary->>''property_id'')::uuid) flags ON true WHERE maintained.org_id=$1 AND maintained.target_kind=r.target_kind AND maintained.target_id=r.target_id AND coalesce(flags.drip_replied,false))';
 WHEN 'dispo' THEN predicate:='r.target_kind=''known_conversation'' AND r.review';
 WHEN 'unknown' THEN predicate:='r.target_kind=''unknown_sender'' AND r.unknown_active';
 WHEN 'dismissed' THEN predicate:='r.target_kind=''unknown_sender'' AND r.unknown_dismissed';
 WHEN 'active' THEN predicate:='('||known||') OR (r.target_kind=''unknown_sender'' AND r.unknown_active)';
 ELSE RAISE EXCEPTION 'INBOX_INVALID_VIEW';END CASE;
 query:='SELECT r.target_kind,r.target_id,r.latest_at FROM inbox_bridge.filter_rows r WHERE r.org_id=$1 AND ('||predicate||')';
 IF f->>'search' IS NOT NULL THEN query:=query||' AND (r.target_kind=''unknown_sender'' OR EXISTS(SELECT 1 FROM public.contacts ct WHERE ct.org_id=$1 AND ct.id=r.contact_id AND (ct.search_text ILIKE $3 ESCAPE E''\\'' OR (length($4)>=3 AND ct.phone_digits ILIKE ''%''||$4||''%''))) OR EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=$1 AND m.conversation_id=r.target_id AND m.channel=''sms'' AND m.fts @@ public.search_prefix_tsquery($5)))';END IF;
 IF has_cursor THEN
  IF cursor_at IS NULL THEN query:=query||' AND r.latest_at IS NULL AND (r.target_kind,r.target_id)>($7,$8)';
  ELSE query:=query||' AND (r.latest_at<$6 OR r.latest_at IS NULL OR (r.latest_at=$6 AND (r.target_kind,r.target_id)>($7,$8)))';END IF;
 END IF;
 query:=query||' ORDER BY r.latest_at DESC NULLS LAST,r.target_kind,r.target_id LIMIT $9';
 RETURN QUERY EXECUTE query USING o,u,'%'||replace(replace(replace(lower(f->>'search'),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%',regexp_replace(f->>'search','[^0-9]','','g'),f->>'search',cursor_at,cursor_kind,cursor_id,n;
END $$;

CREATE OR REPLACE FUNCTION inbox_bridge.matching(o uuid,u uuid,f jsonb)
RETURNS TABLE(target_kind text,target_id uuid,latest_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH p AS (SELECT f->>'view' AS view, (f->>'hide_noise')::boolean AS hide_noise,f->>'search' AS q),
 candidates AS (
 SELECT r.target_kind,r.target_id,r.summary s,CASE WHEN r.target_kind='unknown_sender' THEN (r.summary->>'latest_at')::timestamptz ELSE (r.summary->>'last_message_at')::timestamptz END latest_at
 FROM inbox_maintained.rows r WHERE r.org_id=o AND (r.summary->>'exists')::boolean
 ), flagged AS (
  SELECT c.*,flags.in_drip,flags.drip_replied
  FROM candidates c
  LEFT JOIN LATERAL inbox_bridge.drip_flags(o,(c.s->>'property_id')::uuid) flags ON c.target_kind='known_conversation'
 )
 SELECT c.target_kind,c.target_id,c.latest_at FROM flagged c CROSS JOIN p
 WHERE CASE WHEN c.target_kind='unknown_sender' THEN
  -- Existing unknown loader does not consume known-conversation search input.
  CASE p.view WHEN 'active' THEN coalesce((c.s->>'visible_unknown')::boolean,false) WHEN 'unknown' THEN coalesce((c.s->>'visible_unknown')::boolean,false) WHEN 'dismissed' THEN coalesce((c.s->>'visible_dismissed')::boolean,false) ELSE false END
 ELSE
  CASE p.view WHEN 'unknown' THEN false WHEN 'dismissed' THEN false
   WHEN 'dispo' THEN (c.s->>'ai_disposition_review_id') IS NOT NULL AND NOT coalesce((c.s->>'is_test_traffic')::boolean,false)
   WHEN 'in_drip' THEN coalesce((c.s->>'has_recent')::boolean,false) AND (NOT p.hide_noise OR NOT coalesce((c.s->>'is_noise')::boolean,false)) AND coalesce(c.in_drip,false)
   WHEN 'drip_replied' THEN coalesce((c.s->>'has_recent')::boolean,false) AND (NOT p.hide_noise OR NOT coalesce((c.s->>'is_noise')::boolean,false)) AND coalesce(c.drip_replied,false)
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
 END;
$$;

CREATE FUNCTION public.inbox_drip_counts_v1(org_id uuid,filter jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb; after_access jsonb; f jsonb; result jsonb;
BEGIN
 a:=inbox_bridge.authorize_serving($1);f:=inbox_bridge.normalize_filter($2);
 WITH scoped AS (
  SELECT r.target_kind='known_conversation' AS known,
   r.has_recent,
   r.is_noise,
   coalesce(flags.in_drip,false) AS in_drip,
   coalesce(flags.drip_replied,false) AS drip_replied
  FROM inbox_bridge.filter_rows r
  LEFT JOIN inbox_maintained.rows maintained
    ON maintained.org_id=$1
   AND maintained.target_kind=r.target_kind
   AND maintained.target_id=r.target_id
  LEFT JOIN LATERAL inbox_bridge.drip_flags($1,(maintained.summary->>'property_id')::uuid) flags
    ON r.target_kind='known_conversation'
  WHERE r.org_id=$1
    AND (f->>'search' IS NULL OR r.target_kind='unknown_sender'
      OR EXISTS(SELECT 1 FROM public.contacts ct WHERE ct.org_id=$1 AND ct.id=r.contact_id AND
        (ct.search_text ILIKE '%'||replace(replace(replace(lower(f->>'search'),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%' ESCAPE E'\\'
         OR (length(regexp_replace(f->>'search','[^0-9]','','g'))>=3 AND ct.phone_digits ILIKE '%'||regexp_replace(f->>'search','[^0-9]','','g')||'%')))
      OR EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=$1 AND m.conversation_id=r.target_id AND m.channel='sms' AND m.fts @@ public.search_prefix_tsquery(f->>'search')))
 )
 SELECT jsonb_build_object(
   'in_drip',count(*) FILTER (WHERE known AND has_recent AND (NOT (f->>'hide_noise')::boolean OR NOT is_noise) AND in_drip),
   'drip_replied',count(*) FILTER (WHERE known AND has_recent AND (NOT (f->>'hide_noise')::boolean OR NOT is_noise) AND drip_replied)
 ) INTO result FROM scoped;
 after_access:=inbox_bridge.authorize_serving($1);
 IF (after_access->>'user_id',after_access->>'session_id',after_access->>'org_id',after_access->>'access_epoch') IS DISTINCT FROM
    (a->>'user_id',a->>'session_id',a->>'org_id',a->>'access_epoch') THEN
   RAISE EXCEPTION 'INBOX_ACCESS_CHANGED' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object('org_id',$1,'counts',result,'as_of',statement_timestamp(),'access_epoch',a->>'access_epoch');
END $$;

REVOKE ALL ON FUNCTION public.inbox_drip_counts_v1(uuid,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_drip_counts_v1(uuid,jsonb) TO authenticated;

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
 ), flagged AS (
  SELECT c.*,flags.in_drip,flags.drip_replied
  FROM candidates c
  LEFT JOIN LATERAL inbox_bridge.drip_flags(o,(c.s->>'property_id')::uuid) flags ON c.target_kind='known_conversation'
 ), matching AS (
  SELECT c.target_kind,c.target_id FROM flagged c CROSS JOIN p
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
     WHEN 'in_drip' THEN coalesce(c.in_drip,false)
     WHEN 'drip_replied' THEN coalesce(c.drip_replied,false)
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

CREATE FUNCTION public.inbox_drip_label_inputs_v1(org_id uuid,conversation_id uuid,message_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=''
SET lock_timeout='3s' SET statement_timeout='10s' AS $$
DECLARE a jsonb; after_access jsonb; result jsonb;
BEGIN
 a:=public.inbox_authorize_sync($1);
 -- Label inputs intentionally accept at most 50 message ids, matching the canonical history page.
 IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR cardinality($3)>50 OR
    EXISTS(SELECT 1 FROM unnest($3) id WHERE id IS NULL) THEN
   RAISE EXCEPTION 'INBOX_INVALID_LABEL_INPUTS' USING ERRCODE='22023';
 END IF;
 WITH requested AS MATERIALIZED (
   SELECT id,min(ordinal)::bigint AS ordinal
   FROM unnest($3) WITH ORDINALITY input(id,ordinal)
   GROUP BY id
 ), page AS MATERIALIZED (
   SELECT m.id,m.created_at,m.body,m.direction,m.status,m.metadata,true AS is_page
   FROM public.messages m
   JOIN requested r ON r.id=m.id
   WHERE m.org_id=$1 AND m.conversation_id=$2 AND m.channel='sms'
 ), oldest AS (
   SELECT created_at,id FROM page WHERE is_page ORDER BY created_at,id LIMIT 1
 ), lookbehind AS MATERIALIZED (
   SELECT m.id,m.created_at,m.body,m.direction,m.status,m.metadata,false AS is_page
   FROM public.messages m CROSS JOIN oldest o
   WHERE m.org_id=$1 AND m.conversation_id=$2 AND m.channel='sms'
     AND (m.created_at,m.id)<(o.created_at,o.id)
     AND (m.direction='inbound' OR (m.direction='outbound'
       AND (m.metadata->>'generated_by' is distinct from 'ai_responder_v1'
         OR EXISTS(SELECT 1 FROM public.sequence_step_runs run WHERE run.message_id=m.id))))
   ORDER BY m.created_at DESC,m.id DESC LIMIT 1
 ), combined AS (
   SELECT * FROM lookbehind UNION ALL SELECT * FROM page
 ), drip AS MATERIALIZED (
   SELECT c.*,
     labels.drip_name,labels.drip_step,labels.drip_steps_total,
     (c.direction='inbound' OR (c.direction='outbound' AND
       (c.metadata->>'generated_by' is distinct from 'ai_responder_v1' OR labels.drip_step IS NOT NULL))) AS meaningful
   FROM combined c
   LEFT JOIN LATERAL (
     SELECT seq.name AS drip_name,step.step_index+1 AS drip_step,
       (SELECT count(*)::integer FROM public.sequence_steps total WHERE total.sequence_id=step.sequence_id) AS drip_steps_total
     FROM public.sequence_step_runs run
     JOIN public.sequence_steps step ON step.id=run.step_id
     JOIN public.sequence_enrollments enrollment ON enrollment.id=run.enrollment_id
       AND enrollment.org_id=$1
     JOIN public.sequences seq ON seq.id=step.sequence_id AND seq.org_id=$1
     WHERE run.message_id=c.id
     ORDER BY run.id DESC LIMIT 1
   ) labels ON true
 ), labeled AS (
   SELECT c.*,previous.drip_step AS previous_drip_step
   FROM drip c
   LEFT JOIN LATERAL (
     SELECT prior.drip_step
     FROM drip prior
     WHERE prior.meaningful AND (prior.created_at,prior.id)<(c.created_at,c.id)
     ORDER BY prior.created_at DESC,prior.id DESC LIMIT 1
   ) previous ON true
 )
 SELECT jsonb_build_object(
   'org_id',$1,'conversation_id',$2,
   'messages',coalesce((SELECT jsonb_agg(jsonb_build_object(
     'id',id,'created_at_raw',created_at::text,'body',body,'direction',direction,'status',status,
     'is_page',is_page,
     'drip_name',CASE WHEN is_page THEN drip_name END,
     'drip_step',CASE WHEN is_page THEN drip_step END,
     'drip_steps_total',CASE WHEN is_page THEN drip_steps_total END,
     'previous_drip_step',CASE WHEN is_page THEN previous_drip_step END
   ) ORDER BY created_at,id) FROM labeled),'[]'::jsonb)
 ) INTO result;
 after_access:=public.inbox_authorize_sync($1);
 IF (after_access->>'user_id',after_access->>'session_id',after_access->>'org_id',after_access->>'access_epoch') IS DISTINCT FROM
    (a->>'user_id',a->>'session_id',a->>'org_id',a->>'access_epoch') THEN
   RAISE EXCEPTION 'INBOX_ACCESS_CHANGED' USING ERRCODE='42501';
 END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.inbox_drip_label_inputs_v1(uuid,uuid,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_drip_label_inputs_v1(uuid,uuid,uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
