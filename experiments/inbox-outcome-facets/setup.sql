-- Disposable fixture candidate; requires reviewed performance dependency. No production migration.
BEGIN;
DO $$ BEGIN IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
ALTER TABLE inbox_t2_bridge.filter_rows ADD COLUMN outreach_dispo text;
CREATE OR REPLACE FUNCTION inbox_t2_bridge.upsert_filter(o uuid,k text,id uuid,v bigint,s jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF (s->>'exists')::boolean IS DISTINCT FROM true THEN DELETE FROM inbox_t2_bridge.filter_rows WHERE org_id=o AND target_kind=k AND target_id=id;RETURN;END IF;
 INSERT INTO inbox_t2_bridge.filter_rows VALUES(o,k,id,v,
 (CASE WHEN k='unknown_sender' THEN s->>'latest_at' ELSE s->>'last_message_at' END)::timestamptz,
 (s->>'contact_id')::uuid,coalesce((s->>'has_recent')::boolean,false),coalesce((s->>'is_noise')::boolean,false),
 coalesce(s->>'property_status'<>'prospect',false),(s->>'assigned_user_id')::uuid,
 CASE WHEN k='unknown_sender' THEN NULL ELSE coalesce((s->>'unread_count')::bigint,0)>0 END,
 coalesce(s->>'ai_responder_status'='escalated',false),coalesce((s->>'needs_outcome')::boolean,false),
 s->>'ai_disposition_review_id' IS NOT NULL AND NOT coalesce((s->>'is_test_traffic')::boolean,false),
 coalesce((s->>'visible_unknown')::boolean,false),coalesce((s->>'visible_dismissed')::boolean,false),s->>'outreach_dispo')
 ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET revision=excluded.revision,latest_at=excluded.latest_at,contact_id=excluded.contact_id,
 has_recent=excluded.has_recent,is_noise=excluded.is_noise,assignable=excluded.assignable,assigned_user_id=excluded.assigned_user_id,unread=excluded.unread,
 escalated=excluded.escalated,needs_outcome=excluded.needs_outcome,review=excluded.review,unknown_active=excluded.unknown_active,unknown_dismissed=excluded.unknown_dismissed,outreach_dispo=excluded.outreach_dispo
 WHERE inbox_t2_bridge.filter_rows.revision<excluded.revision;
END $$;

CREATE FUNCTION inbox_t2_bridge.outcome_counts(o uuid,u uuid,f jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH scoped AS (
 SELECT r.outreach_dispo,r.target_kind,r.has_recent,r.is_noise,r.unknown_active
 FROM inbox_t2_bridge.filter_rows r WHERE r.org_id=o
 AND (f->>'search' IS NULL OR r.target_kind='unknown_sender'
 OR EXISTS(SELECT 1 FROM public.contacts ct WHERE ct.org_id=o AND ct.id=r.contact_id AND
  (ct.search_text ILIKE '%'||replace(replace(replace(lower(f->>'search'),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%' ESCAPE E'\\'
  OR (length(regexp_replace(f->>'search','[^0-9]','','g'))>=3 AND ct.phone_digits ILIKE '%'||regexp_replace(f->>'search','[^0-9]','','g')||'%')))
 OR EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=o AND m.conversation_id=r.target_id AND m.channel='sms' AND m.fts @@ public.search_prefix_tsquery(f->>'search')))

 ), grouped AS (
 SELECT coalesce(outreach_dispo,'no_outcome') AS outcome,
 count(*) FILTER(WHERE target_kind='known_conversation' AND has_recent AND (NOT (f->>'hide_noise')::boolean OR NOT is_noise)) AS total,
 count(*) FILTER(WHERE target_kind='unknown_sender' AND unknown_active) AS unknown_total FROM scoped
 GROUP BY coalesce(outreach_dispo,'no_outcome')
 ), taxonomy AS (
 SELECT unnest(ARRAY['wrong_number','bad_number','not_interested','opted_out','dnc','nurture','callback_requested','needs_sequence','booked_appointment','no_outcome']) AS outcome
 ), totals AS (
 SELECT taxonomy.outcome,coalesce(grouped.total,0) AS total FROM taxonomy LEFT JOIN grouped USING(outcome)
 UNION ALL SELECT outcome,total FROM grouped WHERE outcome NOT IN(SELECT outcome FROM taxonomy)
 ) SELECT jsonb_build_object('outcome_counts',(SELECT jsonb_object_agg(outcome,total) FROM totals),
 'known_total',(SELECT coalesce(sum(total),0) FROM grouped),
 'unknown_count',(SELECT coalesce(sum(unknown_total),0) FROM grouped));
$$;
CREATE FUNCTION public.inbox_outcome_counts_v1(org_id uuid,filter jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;after_access jsonb;f jsonb;result jsonb;
BEGIN
 a:=inbox_t2_bridge.authorize(org_id);f:=inbox_t2_bridge.normalize_filter(filter);
 SELECT inbox_t2_bridge.outcome_counts(org_id,(a->>'user_id')::uuid,f) INTO result;
 after_access:=inbox_t2_bridge.authorize(org_id);
 IF (after_access->>'user_id',after_access->>'session_id',after_access->>'access_epoch') IS DISTINCT FROM (a->>'user_id',a->>'session_id',a->>'access_epoch') THEN RAISE EXCEPTION 'INBOX_ACCESS_CHANGED' USING ERRCODE='42501';END IF;
 RETURN result||jsonb_build_object('as_of',statement_timestamp(),'access_epoch',a->>'access_epoch','semantics',jsonb_build_object('known','recent_known_conversations','hide_noise',(f->>'hide_noise')::boolean,'search',f->'search','unknown','active_unknown_ignores_known_search','unit','conversation','view','all'));
END $$;
REVOKE ALL ON FUNCTION inbox_t2_bridge.outcome_counts(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_outcome_counts_v1(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_outcome_counts_v1(uuid,jsonb) TO authenticated;
COMMIT;
