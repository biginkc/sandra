-- GENERATED REVIEW CANDIDATE. No production execution authorized.
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='120s';
DO $$ BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'Expected migration role postgres';END IF;
 IF to_regclass('public.messages') IS NULL OR to_regclass('public.memberships') IS NULL OR to_regclass('auth.sessions') IS NULL THEN RAISE EXCEPTION 'Canonical schema missing';END IF;
 IF NOT has_table_privilege(current_user,'auth.sessions','SELECT') OR NOT has_table_privilege(current_user,'auth.sessions','TRIGGER') THEN RAISE EXCEPTION 'Canonical session privileges unavailable';END IF;
 IF to_regnamespace('inbox_control') IS NOT NULL THEN RAISE EXCEPTION 'Existing candidate: use validated forward upgrade, never reset';END IF;
END $$;
CREATE SCHEMA inbox_control AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_control FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_control.rollout(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),schema_version integer NOT NULL,serving_enabled boolean NOT NULL DEFAULT false,backfill_complete boolean NOT NULL DEFAULT false,reconciliation_complete boolean NOT NULL DEFAULT false,installed_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE inbox_control.rollout ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_control.rollout FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO inbox_control.rollout(singleton,schema_version) VALUES(true,1);
-- Component heads; pinned ccc77911ab769d1dd43d3c96023fb56199feaf24b673a4886aa00b5004fea08a
-- T2 candidate, intentionally outside supabase/migrations.
-- Apply only to the explicitly owned offline source-schema rehearsal.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- ACCESS EXCLUSIVE spans baseline installation and trigger publication. Existing
-- tuples read as revision zero; a concurrent insert cannot pass between them.
LOCK TABLE public.messages IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.messages ADD COLUMN inbox_inbound_revision bigint NOT NULL DEFAULT 0;
-- NOT VALID avoids a historical-row validation scan inside installation's lock.
-- New/updated rows are checked immediately; later validation is a separate gate.
ALTER TABLE public.messages ADD CONSTRAINT messages_inbox_inbound_revision_nonnegative
  CHECK (inbox_inbound_revision >= 0) NOT VALID;
CREATE TABLE public.inbox_inbound_heads (
  org_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  PRIMARY KEY (org_id, conversation_id)
);
-- No FK: deleting/reinserting an identity must not reset its counter.
ALTER TABLE public.inbox_inbound_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_inbound_heads FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.inbox_capture_inbound_head()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE next_revision bigint;
BEGIN
  IF NEW.channel IS DISTINCT FROM 'sms' OR NEW.direction IS DISTINCT FROM 'inbound'
     OR NEW.org_id IS NULL OR NEW.conversation_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.conversation_id, NEW.channel, NEW.direction)
       IS NOT DISTINCT FROM (OLD.org_id, OLD.conversation_id, OLD.channel, OLD.direction) THEN
      RETURN NULL;
    END IF;
  END IF;
  INSERT INTO public.inbox_inbound_heads(org_id, conversation_id, revision)
    VALUES (NEW.org_id, NEW.conversation_id, 1)
  ON CONFLICT (org_id, conversation_id) DO UPDATE
    SET revision = public.inbox_inbound_heads.revision + 1
  RETURNING revision INTO next_revision;
  -- The original source write already holds its tuple lock. The head lock and
  -- this stamp remain in that same transaction through commit or rollback.
  UPDATE public.messages SET inbox_inbound_revision = next_revision
    WHERE id = NEW.id AND org_id = NEW.org_id AND conversation_id = NEW.conversation_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.inbox_capture_inbound_head() FROM PUBLIC, anon, authenticated, service_role;
-- Invoker context sees the real caller, except during the allocator's explicit
-- SECURITY DEFINER self-update. No pg_trigger_depth or caller-settable GUC trust.
CREATE FUNCTION public.inbox_guard_inbound_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE allocator_owner name;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Even the owner must not supply a fabricated arrival revision at insertion.
    IF NEW.inbox_inbound_revision IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'INBOX_REVISION_SERVER_OWNED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.inbox_inbound_revision IS DISTINCT FROM OLD.inbox_inbound_revision THEN
    SELECT r.rolname INTO STRICT allocator_owner
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'public.inbox_capture_inbound_head()'::pg_catalog.regprocedure;
    IF CURRENT_USER IS DISTINCT FROM allocator_owner THEN
      RAISE EXCEPTION 'INBOX_REVISION_SERVER_OWNED' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.inbox_guard_inbound_revision() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER zzz_inbox_guard_inbound_revision_insert
  BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.inbox_guard_inbound_revision();
CREATE TRIGGER zzz_inbox_guard_inbound_revision_update
  BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.inbox_guard_inbound_revision();
CREATE TRIGGER inbox_capture_inbound_head
  AFTER INSERT OR UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.inbox_capture_inbound_head();
COMMENT ON TABLE public.inbox_inbound_heads IS
  'T2 transactional per-org/conversation inbound arrival head; retain counters across source deletion. No global commit ordering claim.';
COMMENT ON COLUMN public.messages.inbox_inbound_revision IS
  'Zero is atomic pre-capture baseline; positive revision allocated on inbound SMS membership entry, after canonical identity stamping.';


-- Component known_summary; pinned f24712b35916307cdd0050017e01860cc7ee8939e32fb183ab2158822d43be30
-- Worker-private, source-faithful compute candidate. Offline rehearsal only.
-- Canonical source: supabase/migrations/20260909080000_messages_search.sql.
-- No user authorization, search, aggregation across conversations, or production migration.

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

CREATE SCHEMA inbox_summary_contract AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_summary_contract FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_summary_contract.compute(p_org_id uuid,p_conversation_id uuid,p_as_of timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 WITH bounds AS (SELECT p_as_of - interval '2160 hours' AS cutoff),
  pending_reviews as materialized (
    select
      review.id,
      review.org_id,
      review.property_id,
      review.conversation_id,
      review.source_inbound_message_id,
      review.disposition,
      review.ai_reason,
      review.status,
      review.created_at
    from public.ai_disposition_reviews review
    where review.status = 'pending'
      and review.org_id = p_org_id and review.conversation_id = p_conversation_id
  ),
  recent_eligible as not materialized (
    select
      m.id,
      m.org_id,
      m.conversation_id,
      m.contact_id,
      m.property_id,
      m.direction,
      m.read_at,
      m.created_at,
      m.from_address,
      m.to_address,
      row_number() over (
        partition by m.org_id, m.conversation_id
        order by m.created_at desc, m.id desc
      ) as latest_rank
    from public.messages m
    where m.channel = 'sms'
      and m.contact_id is not null
      and m.conversation_id is not null
      and m.status not in ('queued', 'paused')
      and m.created_at >= (select cutoff from bounds)
      and m.org_id = p_org_id and m.conversation_id = p_conversation_id
  ),
  recent_grouped as materialized (
    select
      e.org_id,
      e.conversation_id,
      (array_agg(e.id) filter (where e.latest_rank = 1))[1] as last_message_id,
      (array_agg(e.contact_id) filter (where e.latest_rank = 1))[1] as contact_id,
      coalesce(
        (array_agg(e.property_id order by e.created_at desc, e.id desc)
          filter (where e.property_id is not null))[1],
        (
          select review.property_id
          from pending_reviews review
          where review.org_id = e.org_id
            and review.conversation_id = e.conversation_id
          order by review.created_at desc, review.id desc
          limit 1
        )
      ) as property_id,
      count(*) filter (
        where e.direction = 'inbound' and e.read_at is null
      )::integer as unread_count,
      bool_or(e.direction = 'inbound') as has_inbound,
      true as has_recent,
      max(e.direction) filter (where e.latest_rank = 1) as last_message_direction,
      max(e.created_at) filter (where e.latest_rank = 1) as last_message_at,
      max(e.from_address) filter (where e.latest_rank = 1) as latest_from,
      max(e.to_address) filter (where e.latest_rank = 1) as latest_to
    from recent_eligible e
    group by e.org_id, e.conversation_id
  ),
  old_review_conversations as materialized (
    select review.*
    from pending_reviews review
    where not exists (
      select 1
      from recent_grouped recent
      where recent.org_id = review.org_id
        and recent.conversation_id = review.conversation_id
    )
  ),
  old_review_eligible as materialized (
    select
      m.id,
      m.org_id,
      m.conversation_id,
      m.contact_id,
      m.property_id,
      review.property_id as review_property_id,
      m.direction,
      m.read_at,
      m.created_at,
      m.from_address,
      m.to_address,
      row_number() over (
        partition by m.org_id, m.conversation_id
        order by m.created_at desc, m.id desc
      ) as latest_rank
    from old_review_conversations review
    join public.messages m
      on m.org_id = review.org_id
      and m.conversation_id = review.conversation_id
    where m.channel = 'sms'
      and m.contact_id is not null
      and m.status not in ('queued', 'paused')
  ),
  old_review_grouped as materialized (
    select
      e.org_id,
      e.conversation_id,
      (array_agg(e.id order by e.created_at desc, e.id desc))[1] as last_message_id,
      (array_agg(e.contact_id order by e.created_at desc, e.id desc))[1] as contact_id,
      (array_agg(e.review_property_id order by e.created_at desc, e.id desc))[1] as property_id,
      count(*) filter (
        where e.direction = 'inbound' and e.read_at is null
      )::integer as unread_count,
      bool_or(e.direction = 'inbound') as has_inbound,
      false as has_recent,
      max(e.direction) filter (where e.latest_rank = 1) as last_message_direction,
      max(e.created_at) filter (where e.latest_rank = 1) as last_message_at,
      max(e.from_address) filter (where e.latest_rank = 1) as latest_from,
      max(e.to_address) filter (where e.latest_rank = 1) as latest_to
    from old_review_eligible e
    group by e.org_id, e.conversation_id
  ),
  grouped as materialized (
    select recent.*
    from recent_grouped recent

    union all

    select review.*
    from old_review_grouped review
  ),
  core as materialized (
    select
      g.*,
      coalesce(c.entity_name, nullif(concat_ws(' ', c.first_name, c.last_name), '')) as contact_name,
      c.do_not_contact,
      c.sms_opted_out,
      nullif(concat_ws(', ', p.address, p.city, p.state), '') as property_address,
      p.status as property_status,
      p.outreach_dispo,
      p.is_dnc_locked,
      p.assigned_user_id,
      p.needs_human_attention,
      p.last_ai_escalation_reason,
      mt.ai_responder_status,
      ce.event_type as latest_consent_event,
      suppression.phone_e164 is not null as is_phone_suppressed,
      review.id as ai_disposition_review_id,
      review.status as ai_disposition_review_status,
      review.disposition as ai_disposition_review_disposition,
      review.ai_reason as ai_disposition_review_reason,
      review.created_at as ai_disposition_review_created_at,
      review.source_inbound_message_id as ai_disposition_review_source_inbound_message_id,
      case when g.last_message_direction = 'inbound' then g.latest_from else g.latest_to end as thread_customer_phone,
      case when g.last_message_direction = 'inbound' then g.latest_to else g.latest_from end as thread_business_phone
    from grouped g
    left join public.contacts c on c.id = g.contact_id and c.org_id = g.org_id
    left join public.properties p on p.id = g.property_id and p.org_id = g.org_id
    left join pending_reviews review
      on review.org_id = g.org_id
      and review.conversation_id = g.conversation_id
      and review.property_id = g.property_id
    left join public.message_threads mt on mt.conversation_id = g.conversation_id and mt.org_id = g.org_id
    left join lateral (
      select consent.event_type
      from public.consent_events consent
      where consent.contact_id = g.contact_id
        and consent.org_id = g.org_id
        and consent.channel = 'sms'
        and consent.event_type in (
          'opt_in_marketing_written',
          'opt_in_informational',
          'opt_in_confirmed',
          'opt_out',
          'provider_auto_opt_out'
        )
      order by consent.occurred_at desc, consent.id desc
      limit 1
    ) ce on true
    left join lateral (
      select case
        when length(phone.digits) = 11 and left(phone.digits, 1) = '1'
          then '+' || phone.digits
        when length(phone.digits) = 10
          then '+1' || phone.digits
        else null
      end as phone_e164
      from (
        select regexp_replace(
          coalesce(case when g.last_message_direction = 'inbound' then g.latest_from else g.latest_to end, ''),
          '[^0-9]',
          '',
          'g'
        ) as digits
      ) phone
    ) normalized_phone on true
    left join public.sms_phone_suppressions suppression
      on suppression.org_id = g.org_id
      and suppression.channel = 'sms'
      and suppression.phone_e164 = normalized_phone.phone_e164

  ),
  ready as materialized (
    select
      c.*,
      coalesce(c.do_not_contact, false)
        or coalesce(c.sms_opted_out, false)
        or c.is_phone_suppressed
        or coalesce(c.latest_consent_event in ('opt_out', 'provider_auto_opt_out'), false) as is_opted_out,
      lower(trim(coalesce(c.contact_name, ''))) like 'canary canary-%%'
        or lower(trim(coalesce(c.property_address, ''))) like 'jitter %%'
        or lower(trim(coalesce(c.property_address, ''))) like 'jitter-%%' as is_test_traffic
    from core c
  ),
  classified as materialized (
    select
      r.*,
      r.property_id is not null
        and r.has_inbound
        and r.outreach_dispo is null
        and not r.is_opted_out
        and r.property_status in ('prospect', 'new_lead', 'contacted') as needs_outcome,
      coalesce(r.is_dnc_locked, false) or r.is_opted_out or r.is_test_traffic as is_noise
    from ready r
  ),
  summary AS (
   SELECT (to_jsonb(c) - 'latest_from' - 'latest_to' - 'latest_consent_event'
     - 'ai_disposition_review_reason' - 'last_ai_escalation_reason') || jsonb_build_object(
    'target_kind','known_conversation','as_of',p_as_of,'cutoff',p_as_of-interval '2160 hours',
    'exists',true,'last_message_status',m.status,'last_message_preview',left(m.body,120),
    'assignment_eligible',c.property_status IS NOT NULL AND c.property_status<>'prospect',
    'visible_all_hide_noise',c.has_recent AND NOT c.is_noise,
    'visible_all_show_noise',c.has_recent,
    'visible_unread_hide_noise',c.has_recent AND NOT c.is_noise AND c.unread_count>0,
    'visible_escalated_hide_noise',coalesce(c.has_recent AND NOT c.is_noise AND c.ai_responder_status='escalated',false),
    'visible_needs_outcome_hide_noise',coalesce(c.has_recent AND NOT c.is_noise AND c.needs_outcome,false),
    'visible_review',c.ai_disposition_review_id IS NOT NULL AND NOT c.is_test_traffic,
    -- Exact cutoff equality remains eligible. Recompute at this deadline + 1us.
    'next_window_expiry',(
      SELECT min(e.created_at+interval '2160 hours') FROM recent_eligible e
    )
   ) AS value
   FROM classified c JOIN public.messages m
    ON m.id=c.last_message_id AND m.org_id=c.org_id AND m.conversation_id=c.conversation_id
  )
 SELECT CASE WHEN p_org_id IS NULL OR p_conversation_id IS NULL OR p_as_of IS NULL THEN
  jsonb_build_object('error','invalid_compute_scope')
 ELSE coalesce((SELECT value FROM summary),jsonb_build_object(
  'target_kind','known_conversation','org_id',p_org_id,'conversation_id',p_conversation_id,
  'as_of',p_as_of,'exists',false,'visible_all_hide_noise',false,'visible_review',false)) END;
$$;
REVOKE ALL ON FUNCTION inbox_summary_contract.compute(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;


-- Component unknown_summary; pinned e8604e26e0032b17fd1226da93b8717926cedd824b4bab08434ac58c305b7769
-- Isolated private unknown-sender compute. No production migration or commands.

SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';

CREATE SCHEMA inbox_unknown_summary AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_unknown_summary FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_unknown_summary.compute(p_org uuid,p_raw_sender text,p_as_of timestamptz)
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
CREATE FUNCTION inbox_unknown_summary.propose_message_ids(p_org uuid,p_raw_sender text,p_action text,p_max integer DEFAULT 200)
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_unknown_summary FROM PUBLIC,anon,authenticated,service_role;


-- Component detail_v1; pinned 8e13aaea327dafa55bac4185ead4024099b467e52f6a65908331018df810d8c6
-- Isolated fixture candidate only; not a production migration.

SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';

CREATE SCHEMA inbox_authenticated_detail AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_authenticated_detail FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA inbox_authenticated_detail TO authenticated;
CREATE FUNCTION inbox_authenticated_detail.detail(p_org uuid,p_conversation uuid,p_before timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE visible_orgs uuid[]; requester uuid:=auth.uid(); result jsonb;
BEGIN
 IF requester IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN
  RAISE EXCEPTION 'INBOX_AUTH_REQUIRED' USING ERRCODE='42501';
 END IF;
 IF p_org IS NULL OR p_conversation IS NULL OR ((p_before IS NULL) <> (p_before_id IS NULL)) THEN
  RAISE EXCEPTION 'INBOX_INVALID_ARGUMENT' USING ERRCODE='22023';
 END IF;
 -- Do not invoke resolve_sms_conversation_org from a postgres definer: its
 -- current_user branch would bypass the requester check. Match visible-org
 -- ambiguity semantics with explicit actual Hugo lifecycle predicates.
 SELECT array_agg(m.org_id ORDER BY m.org_id) INTO visible_orgs
 FROM public.memberships m
 WHERE m.user_id=requester AND m.access_status='active'
 AND m.deletion_prepared_at IS NULL
 AND (m.access_expires_at IS NULL OR m.access_expires_at>statement_timestamp())
 AND EXISTS(SELECT 1 FROM public.messages x WHERE x.org_id=m.org_id
  AND x.conversation_id=p_conversation AND x.channel='sms');
 IF coalesce(cardinality(visible_orgs),0)>1 THEN
  RAISE EXCEPTION 'SMS_CONVERSATION_ORG_AMBIGUOUS' USING ERRCODE='P0001';
 END IF;
 IF coalesce(cardinality(visible_orgs),0)<>1 OR visible_orgs[1] IS DISTINCT FROM p_org THEN
  RAISE EXCEPTION 'INBOX_ACCESS_DENIED' USING ERRCODE='42501';
 END IF;
 -- A STABLE routine uses its caller statement's snapshot for internal reads.
 -- Head, covered keys, primary-key bodies and ordered JSON are also explicitly
 -- composed in one statement. No read acknowledgment or source writes occur.
 WITH head AS MATERIALIZED (
  SELECT coalesce((SELECT revision FROM public.inbox_inbound_heads
   WHERE org_id=p_org AND conversation_id=p_conversation),0)::text AS revision
 ), page AS MATERIALIZED (
  SELECT id,created_at FROM public.messages WHERE org_id=p_org
  AND conversation_id=p_conversation AND channel='sms'
  AND (p_before IS NULL OR (created_at,id)<(p_before,p_before_id))
  ORDER BY created_at DESC,id DESC LIMIT 50
 ), bodies AS (
  SELECT m.id,p.created_at,m.body,m.direction,m.read_at,m.inbox_inbound_revision
  FROM page p JOIN public.messages m ON m.id=p.id AND m.org_id=p_org
   AND m.conversation_id=p_conversation AND m.channel='sms'
 ) SELECT jsonb_build_object('requester_id',requester,'org_id',p_org,
  'conversation_id',p_conversation,'head_revision',(SELECT revision FROM head),
  'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,
   'created_at_raw',b.created_at::text,'body',b.body,'direction',b.direction,
   'read_at_raw',b.read_at::text,'inbound_revision',b.inbox_inbound_revision::text)
   ORDER BY b.created_at DESC,b.id DESC) FROM bodies b),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_authenticated_detail FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION inbox_authenticated_detail.detail(uuid,uuid,timestamptz,uuid) TO authenticated;


-- Component detail_v2; pinned bee0520f65816a19b211d6962cabad836a8e21d632b648af838c1d3840987620
-- Isolated fixture candidate only; not a production migration.

SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';

-- v1 schema/function deliberately retained for side-by-side evidence.
CREATE FUNCTION inbox_authenticated_detail.detail_v2(p_org uuid,p_conversation uuid,p_before timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE visible_orgs uuid[]; requester uuid:=auth.uid(); result jsonb;
BEGIN
 IF requester IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN
  RAISE EXCEPTION 'INBOX_AUTH_REQUIRED' USING ERRCODE='42501';
 END IF;
 IF p_org IS NULL OR p_conversation IS NULL OR ((p_before IS NULL) <> (p_before_id IS NULL)) THEN
  RAISE EXCEPTION 'INBOX_INVALID_ARGUMENT' USING ERRCODE='22023';
 END IF;
 -- Do not invoke resolve_sms_conversation_org from a postgres definer: its
 -- current_user branch would bypass the requester check. Match visible-org
 -- ambiguity semantics with explicit actual Hugo lifecycle predicates.
 SELECT array_agg(m.org_id ORDER BY m.org_id) INTO visible_orgs
 FROM public.memberships m
 WHERE m.user_id=requester AND m.access_status='active'
 AND m.deletion_prepared_at IS NULL
 AND (m.access_expires_at IS NULL OR m.access_expires_at>statement_timestamp())
 AND EXISTS(SELECT 1 FROM public.messages x WHERE x.org_id=m.org_id
  AND x.conversation_id=p_conversation AND x.channel='sms');
 IF coalesce(cardinality(visible_orgs),0)>1 THEN
  RAISE EXCEPTION 'SMS_CONVERSATION_ORG_AMBIGUOUS' USING ERRCODE='P0001';
 END IF;
 IF coalesce(cardinality(visible_orgs),0)<>1 OR visible_orgs[1] IS DISTINCT FROM p_org THEN
  RAISE EXCEPTION 'INBOX_ACCESS_DENIED' USING ERRCODE='42501';
 END IF;
 -- A STABLE routine uses its caller statement's snapshot for internal reads.
 -- Head, covered keys, primary-key bodies and ordered JSON are also explicitly
 -- composed in one statement. No read acknowledgment or source writes occur.
 IF p_before IS NULL THEN
 WITH head AS MATERIALIZED (
  SELECT coalesce((SELECT revision FROM public.inbox_inbound_heads
   WHERE org_id=p_org AND conversation_id=p_conversation),0)::text AS revision
 ), page AS MATERIALIZED (
  SELECT id,created_at FROM public.messages WHERE org_id=p_org
  AND conversation_id=p_conversation AND channel='sms'
  ORDER BY created_at DESC,id DESC LIMIT 50
 ), bodies AS (
  SELECT m.id,p.created_at,m.body,m.direction,m.read_at,m.inbox_inbound_revision
  FROM page p JOIN public.messages m ON m.id=p.id AND m.org_id=p_org
   AND m.conversation_id=p_conversation AND m.channel='sms'
 ) SELECT jsonb_build_object('requester_id',requester,'org_id',p_org,
  'conversation_id',p_conversation,'head_revision',(SELECT revision FROM head),
  'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,
   'created_at_raw',b.created_at::text,'body',b.body,'direction',b.direction,
   'read_at_raw',b.read_at::text,'inbound_revision',b.inbox_inbound_revision::text)
   ORDER BY b.created_at DESC,b.id DESC) FROM bodies b),'[]'::jsonb)) INTO result;
 ELSE
 WITH head AS MATERIALIZED (
  SELECT coalesce((SELECT revision FROM public.inbox_inbound_heads
   WHERE org_id=p_org AND conversation_id=p_conversation),0)::text AS revision
 ), page AS MATERIALIZED (
  SELECT id,created_at FROM public.messages WHERE org_id=p_org
  AND conversation_id=p_conversation AND channel='sms'
  AND (created_at,id)<(p_before,p_before_id)
  ORDER BY created_at DESC,id DESC LIMIT 50
 ), bodies AS (
  SELECT m.id,p.created_at,m.body,m.direction,m.read_at,m.inbox_inbound_revision
  FROM page p JOIN public.messages m ON m.id=p.id AND m.org_id=p_org
   AND m.conversation_id=p_conversation AND m.channel='sms'
 ) SELECT jsonb_build_object('requester_id',requester,'org_id',p_org,
  'conversation_id',p_conversation,'head_revision',(SELECT revision FROM head),
  'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,
   'created_at_raw',b.created_at::text,'body',b.body,'direction',b.direction,
   'read_at_raw',b.read_at::text,'inbound_revision',b.inbox_inbound_revision::text)
   ORDER BY b.created_at DESC,b.id DESC) FROM bodies b),'[]'::jsonb)) INTO result;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION inbox_authenticated_detail.detail_v2(uuid,uuid,timestamptz,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION inbox_authenticated_detail.detail_v2(uuid,uuid,timestamptz,uuid) TO authenticated;


-- Component capture_boundary; pinned 4284a90214179ca2e7148d697d42a2951cbb7c87f4afea3a679f6d1cd3dda4c7
-- Offline fixture only. Deliberately not a production migration or head reset.

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';

CREATE SCHEMA inbox_capture_boundary;
REVOKE ALL ON SCHEMA inbox_capture_boundary FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_capture_boundary.generation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton IS TRUE),
 generation uuid NOT NULL
);
REVOKE ALL ON TABLE inbox_capture_boundary.generation FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE inbox_capture_boundary.generation ENABLE ROW LEVEL SECURITY;
INSERT INTO inbox_capture_boundary.generation(singleton,generation) VALUES(true,gen_random_uuid());
CREATE FUNCTION inbox_capture_boundary.detail(p_org uuid,p_conversation uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; current_generation uuid;
BEGIN
 -- Existing routine performs explicit auth.uid/role + Hugo lifecycle checks.
 -- Both STABLE routines use the caller statement's MVCC snapshot.
 result:=inbox_authenticated_detail.detail_v2(p_org,p_conversation);
 SELECT generation INTO current_generation FROM inbox_capture_boundary.generation WHERE singleton IS TRUE;
 IF current_generation IS NULL THEN
  RAISE EXCEPTION 'INBOX_CAPTURE_METADATA_UNAVAILABLE' USING ERRCODE='55000';
 END IF;
 RETURN result || jsonb_build_object('capture_generation',current_generation);
END $$;
REVOKE ALL ON FUNCTION inbox_capture_boundary.detail(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA inbox_capture_boundary TO authenticated;
GRANT EXECUTE ON FUNCTION inbox_capture_boundary.detail(uuid,uuid) TO authenticated;


-- Component message_capture; pinned 8b26dab36039731397c30220c0b3ad77db1b2a82983c63533c305ec8dc064b04
-- Private offline rehearsal only. Coexists with, does not replace, earlier lab capture.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';

CREATE SCHEMA inbox_message_capture AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_message_capture FROM PUBLIC,anon,authenticated,service_role;
-- Hash selects a bounded lock bucket; raw equality, never hash equality, determines identity.
-- This avoids an unbounded raw text btree key and does not merge hash collisions.
CREATE TABLE inbox_message_capture.sender_buckets(org_id uuid NOT NULL,raw_hash text NOT NULL,PRIMARY KEY(org_id,raw_hash));
CREATE TABLE inbox_message_capture.sender_groups(
 sender_group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL,
 raw_hash text NOT NULL,raw_sender text NOT NULL CHECK(raw_sender<>''));
CREATE INDEX sender_group_lookup ON inbox_message_capture.sender_groups(org_id,raw_hash);
CREATE TABLE inbox_message_capture.dirty(
 org_id uuid NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('known_conversation','unknown_sender')),
 target_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),
 PRIMARY KEY(org_id,target_kind,target_id));
CREATE TABLE inbox_message_capture.versions(
 org_id uuid NOT NULL,namespace text NOT NULL CHECK(namespace IN ('message_content','known_reply','unknown_action')),
 target_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),PRIMARY KEY(org_id,namespace,target_id));
CREATE TABLE inbox_message_capture.route_edges(
 org_id uuid NOT NULL,message_id uuid NOT NULL,conversation_id uuid NOT NULL,phone_e164 text NOT NULL,
 PRIMARY KEY(org_id,message_id));
CREATE INDEX route_edge_fanout ON inbox_message_capture.route_edges(org_id,phone_e164,message_id);
-- All rows/counters survive source deletion except current relationship edges; no canonical FKs.
CREATE FUNCTION inbox_message_capture.sender_id(p_org uuid,p_raw text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE found_id uuid; h text:=md5(p_raw);
BEGIN
 IF p_org IS NULL OR p_raw IS NULL OR p_raw='' THEN RAISE EXCEPTION 'Invalid raw sender'; END IF;
 SELECT sender_group_id INTO found_id FROM inbox_message_capture.sender_groups
 WHERE org_id=p_org AND raw_hash=h AND raw_sender COLLATE "C"=p_raw COLLATE "C";
 IF found_id IS NOT NULL THEN RETURN found_id; END IF;
 -- Write barrier, not just a row lock: stale REPEATABLE READ snapshots must
 -- abort with40001 rather than insert another group after waiting.
 INSERT INTO inbox_message_capture.sender_buckets VALUES(p_org,h)
 ON CONFLICT(org_id,raw_hash) DO UPDATE SET raw_hash=excluded.raw_hash;
 SELECT sender_group_id INTO found_id FROM inbox_message_capture.sender_groups
 WHERE org_id=p_org AND raw_hash=h AND raw_sender COLLATE "C"=p_raw COLLATE "C";
 IF found_id IS NULL THEN
  INSERT INTO inbox_message_capture.sender_groups(org_id,raw_hash,raw_sender) VALUES(p_org,h,p_raw)
  RETURNING sender_group_id INTO found_id;
 END IF;
 RETURN found_id;
END $$;
CREATE FUNCTION inbox_message_capture.capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE known_changed boolean:=true; unknown_changed boolean:=true; content_changed boolean:=true;
 status_eligibility_changed boolean:=false; dismissed_changed boolean:=true; edge_changed boolean:=true;
 sides jsonb; side jsonb; targets jsonb:='[]'; versions jsonb:='[]'; k record;
 o uuid; c uuid; mid uuid; group_id uuid; phone text;
BEGIN
 IF TG_OP='UPDATE' THEN
  known_changed:=(NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel,NEW.direction,NEW.status,NEW.created_at,NEW.body,NEW.from_address,NEW.to_address,NEW.read_at)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel,OLD.direction,OLD.status,OLD.created_at,OLD.body,OLD.from_address,OLD.to_address,OLD.read_at);
  unknown_changed:=(NEW.id,NEW.org_id,NEW.channel,NEW.direction,NEW.contact_id,NEW.from_address,NEW.to_address,NEW.body,NEW.created_at,NEW.dismissed_at)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.channel,OLD.direction,OLD.contact_id,OLD.from_address,OLD.to_address,OLD.body,OLD.created_at,OLD.dismissed_at);
  content_changed:=(NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel,NEW.direction,NEW.body,NEW.from_address,NEW.to_address,NEW.metadata)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel,OLD.direction,OLD.body,OLD.from_address,OLD.to_address,OLD.metadata);
  -- Conservative private candidate assumption: queue/paused entry/exit changes known eligibility.
  status_eligibility_changed:=(NEW.status IN ('queued','paused')) IS DISTINCT FROM (OLD.status IN ('queued','paused'));
  dismissed_changed:=NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at;
  edge_changed:=(NEW.id,NEW.org_id,NEW.conversation_id,NEW.channel,NEW.direction,NEW.from_address,NEW.to_address)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.channel,OLD.direction,OLD.from_address,OLD.to_address);
  IF NOT(known_changed OR unknown_changed OR content_changed OR status_eligibility_changed OR dismissed_changed OR edge_changed) THEN RETURN NULL; END IF;
 END IF;
 sides:=CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(jsonb_build_object('id',NEW.id,'org_id',NEW.org_id,'conversation_id',NEW.conversation_id,'contact_id',NEW.contact_id,'channel',NEW.channel,'direction',NEW.direction,'from_address',NEW.from_address)) WHEN TG_OP='DELETE' THEN jsonb_build_array(jsonb_build_object('id',OLD.id,'org_id',OLD.org_id,'conversation_id',OLD.conversation_id,'contact_id',OLD.contact_id,'channel',OLD.channel,'direction',OLD.direction,'from_address',OLD.from_address)) ELSE jsonb_build_array(jsonb_build_object('id',OLD.id,'org_id',OLD.org_id,'conversation_id',OLD.conversation_id,'contact_id',OLD.contact_id,'channel',OLD.channel,'direction',OLD.direction,'from_address',OLD.from_address),jsonb_build_object('id',NEW.id,'org_id',NEW.org_id,'conversation_id',NEW.conversation_id,'contact_id',NEW.contact_id,'channel',NEW.channel,'direction',NEW.direction,'from_address',NEW.from_address)) END;
 -- Acquire new raw identity buckets in stable org/hash/raw order before dirty/version locks.
 FOR side IN SELECT value FROM jsonb_array_elements(sides)
  ORDER BY value->>'org_id',md5(value->>'from_address'),(value->>'from_address') COLLATE "C"
 LOOP
  o:=(side->>'org_id')::uuid; c:=(side->>'conversation_id')::uuid; mid:=(side->>'id')::uuid;
  IF content_changed OR status_eligibility_changed THEN versions:=versions||jsonb_build_array(jsonb_build_object('org',o,'namespace','message_content','id',mid)); END IF;
  IF side->>'channel'='sms' AND c IS NOT NULL THEN
   IF known_changed THEN targets:=targets||jsonb_build_array(jsonb_build_object('org',o,'kind','known_conversation','id',c)); END IF;
   IF content_changed OR status_eligibility_changed THEN versions:=versions||jsonb_build_array(jsonb_build_object('org',o,'namespace','known_reply','id',c)); END IF;
  END IF;
  IF side->>'channel'='sms' AND side->>'direction'='inbound' AND side->>'contact_id' IS NULL
   AND side->>'from_address' IS NOT NULL AND side->>'from_address'<>'' THEN
   group_id:=inbox_message_capture.sender_id(o,side->>'from_address');
   IF unknown_changed THEN targets:=targets||jsonb_build_array(jsonb_build_object('org',o,'kind','unknown_sender','id',group_id)); END IF;
   IF content_changed OR dismissed_changed THEN versions:=versions||jsonb_build_array(jsonb_build_object('org',o,'namespace','unknown_action','id',group_id)); END IF;
  END IF;
 END LOOP;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid AS org,value->>'kind' AS kind,(value->>'id')::uuid AS id FROM jsonb_array_elements(targets) ORDER BY 1,2,3 LOOP
  INSERT INTO inbox_message_capture.dirty VALUES(k.org,k.kind,k.id,1)
  ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;
 END LOOP;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid AS org,value->>'namespace' AS namespace,(value->>'id')::uuid AS id FROM jsonb_array_elements(versions) ORDER BY 1,2,3 LOOP
  INSERT INTO inbox_message_capture.versions VALUES(k.org,k.namespace,k.id,1)
  ON CONFLICT(org_id,namespace,target_id) DO UPDATE SET revision=inbox_message_capture.versions.revision+1;
 END LOOP;
 IF edge_changed THEN
  -- At most old/new source edges, never a fanout scan.
  IF TG_OP<>'INSERT' THEN DELETE FROM inbox_message_capture.route_edges WHERE org_id=OLD.org_id AND message_id=OLD.id; END IF;
  IF TG_OP<>'DELETE' AND NEW.channel='sms' AND NEW.conversation_id IS NOT NULL THEN
   phone:=regexp_replace(coalesce(CASE WHEN NEW.direction='inbound' THEN NEW.from_address ELSE NEW.to_address END,''),'[^0-9]','','g');
   phone:=CASE WHEN length(phone)=10 THEN '+1'||phone WHEN length(phone)=11 AND left(phone,1)='1' THEN '+'||phone ELSE NULL END;
   IF phone IS NOT NULL THEN INSERT INTO inbox_message_capture.route_edges VALUES(NEW.org_id,NEW.id,NEW.conversation_id,phone)
    ON CONFLICT(org_id,message_id) DO UPDATE SET conversation_id=excluded.conversation_id,phone_e164=excluded.phone_e164; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_message_direct AFTER INSERT OR UPDATE OR DELETE ON public.messages
 FOR EACH ROW EXECUTE FUNCTION inbox_message_capture.capture();
ALTER TABLE inbox_message_capture.sender_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_message_capture.sender_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_message_capture.dirty ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_message_capture.versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_message_capture.route_edges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_message_capture FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_message_capture FROM PUBLIC,anon,authenticated,service_role;


-- Component maintained; pinned 256ea6fe951440b6879acfec0502698b9a3a8203be04aa68bf09e15274133966
-- Owned canonical fixture integration. Not a production migration.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';

CREATE SCHEMA inbox_maintained AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_maintained FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_maintained.rows(
 org_id uuid NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('known_conversation','unknown_sender')),
 target_id uuid NOT NULL,revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 source_generation bigint NOT NULL DEFAULT 0 CHECK(source_generation>=0),
 summary jsonb, next_expiry timestamptz,
 PRIMARY KEY(org_id,target_kind,target_id)
);
CREATE INDEX due_expiries ON inbox_maintained.rows(next_expiry,org_id,target_kind,target_id) WHERE next_expiry IS NOT NULL;
ALTER TABLE inbox_maintained.rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_maintained FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_maintained.snapshot(o uuid,k text,t uuid,at_time timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH b AS MATERIALIZED (
 SELECT d.*,coalesce(p.revision,0) AS r FROM inbox_message_capture.dirty d
 LEFT JOIN inbox_maintained.rows p USING(org_id,target_kind,target_id)
 WHERE d.org_id=o AND d.target_kind=k AND d.target_id=t AND at_time IS NOT NULL
 ), computed AS MATERIALIZED (
 SELECT b.*,CASE k WHEN 'known_conversation' THEN inbox_summary_contract.compute(o,t,at_time)
 WHEN 'unknown_sender' THEN (SELECT inbox_unknown_summary.compute(o,g.raw_sender,at_time)
 ||jsonb_build_object('sender_group_id',g.sender_group_id,'identity_mapping_required',false)
 FROM inbox_message_capture.sender_groups g WHERE g.org_id=o AND g.sender_group_id=t) END AS data FROM b
 ) SELECT jsonb_build_object('org_id',o,'target_kind',k,'target_id',t,'generation',generation::text,
 'expected_revision',r::text,'summary',data) FROM computed WHERE data IS NOT NULL;
$$;
CREATE FUNCTION inbox_maintained.publish(candidate jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o uuid:=(candidate->>'org_id')::uuid;k text:=candidate->>'target_kind';t uuid:=(candidate->>'target_id')::uuid;
 g bigint:=(candidate->>'generation')::bigint;r bigint:=(candidate->>'expected_revision')::bigint;
 s jsonb:=candidate->'summary';current_g bigint;p inbox_maintained.rows%ROWTYPE;expiry timestamptz;
BEGIN
 IF o IS NULL OR t IS NULL OR k IS NULL OR k NOT IN ('known_conversation','unknown_sender')
 OR g IS NULL OR g<=0 OR r IS NULL OR r<0 OR jsonb_typeof(s) IS DISTINCT FROM 'object'
 OR (s->>'org_id') IS DISTINCT FROM o::text OR jsonb_typeof(s->'exists') IS DISTINCT FROM 'boolean'
 OR (k='known_conversation' AND ((s->>'target_kind') IS DISTINCT FROM k OR (s->>'conversation_id') IS DISTINCT FROM t::text))
 OR (k='unknown_sender' AND ((s->>'target_kind') IS DISTINCT FROM 'unknown_sender_group' OR (s->>'sender_group_id') IS DISTINCT FROM t::text))
 THEN RETURN 'invalid_candidate'; END IF;
 expiry:=CASE WHEN k='known_conversation' THEN (s->>'next_window_expiry')::timestamptz END;
 -- Source tables are never read/locked after this point. No canonical FKs.
 SELECT generation INTO current_g FROM inbox_message_capture.dirty WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF NOT FOUND OR g>current_g THEN RETURN 'invalid_generation'; END IF;
 INSERT INTO inbox_maintained.rows(org_id,target_kind,target_id) VALUES(o,k,t) ON CONFLICT DO NOTHING;
 SELECT * INTO p FROM inbox_maintained.rows WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF g<p.source_generation THEN RETURN 'invalid_generation'; END IF;
 IF p.revision<>r THEN RETURN 'projection_conflict'; END IF;
 IF g=p.source_generation THEN RETURN 'already_applied'; END IF;
 UPDATE inbox_maintained.rows SET revision=revision+1,source_generation=g,summary=s,next_expiry=expiry
 WHERE org_id=o AND target_kind=k AND target_id=t;
 RETURN 'applied';
END $$;
-- The persisted source_generation is the acknowledgment for this maintained model.
-- An older-G publication leaves d.generation > p.source_generation for pending repair.
CREATE FUNCTION inbox_maintained.wake_expiry(o uuid,k text,t uuid,expected_r bigint,at_time timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p inbox_maintained.rows%ROWTYPE;
BEGIN
 IF at_time IS NULL OR expected_r IS NULL THEN RETURN false; END IF;
 PERFORM 1 FROM inbox_message_capture.dirty WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO p FROM inbox_maintained.rows WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF NOT FOUND OR p.revision<>expected_r OR p.next_expiry IS NULL OR p.next_expiry>=at_time THEN RETURN false; END IF;
 UPDATE inbox_message_capture.dirty SET generation=generation+1 WHERE org_id=o AND target_kind=k AND target_id=t;
 UPDATE inbox_maintained.rows SET next_expiry=NULL WHERE org_id=o AND target_kind=k AND target_id=t;
 RETURN true;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_maintained FROM PUBLIC,anon,authenticated,service_role;


-- Component queue; pinned cb4c12d07ff3f3aef6ccb20fff1894d8e59c89d94586cf250ed0b451b7d79ca2
-- Private fixture queue. One key per target; source writes remain transactional.

SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';

CREATE TABLE inbox_maintained.queue(
 org_id uuid NOT NULL,target_kind text NOT NULL,target_id uuid NOT NULL,
 available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 claim_token uuid,lease_until timestamptz,
 PRIMARY KEY(org_id,target_kind,target_id),CHECK((claim_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX queue_available ON inbox_maintained.queue(available_at,org_id,target_kind,target_id);
ALTER TABLE inbox_maintained.queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_maintained.queue FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_maintained.enqueue_dirty() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO inbox_maintained.queue(org_id,target_kind,target_id) VALUES(NEW.org_id,NEW.target_kind,NEW.target_id)
 ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
CREATE TRIGGER maintained_queue AFTER INSERT OR UPDATE OF generation ON inbox_message_capture.dirty FOR EACH ROW EXECUTE FUNCTION inbox_maintained.enqueue_dirty();
-- Owned fixture bootstrap only. Production backfill needs its separate concurrent-write protocol.
-- Historical enqueue is performed by bounded backfill/repair after installation.
CREATE FUNCTION inbox_maintained.claim_work(p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT 30)
RETURNS SETOF inbox_maintained.queue LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_lease_seconds IS NULL OR p_lease_seconds<1 OR p_lease_seconds>300 THEN RAISE EXCEPTION 'Invalid claim bounds';END IF;
 RETURN QUERY WITH picked AS (
 SELECT q.org_id,q.target_kind,q.target_id FROM inbox_maintained.queue q
 WHERE q.available_at<=statement_timestamp() ORDER BY q.available_at,q.org_id,q.target_kind,q.target_id
 LIMIT p_limit FOR UPDATE SKIP LOCKED
 ) UPDATE inbox_maintained.queue q SET claim_token=gen_random_uuid(),
 lease_until=statement_timestamp()+make_interval(secs=>p_lease_seconds),available_at=statement_timestamp()+make_interval(secs=>p_lease_seconds)
 FROM picked p WHERE (q.org_id,q.target_kind,q.target_id)=(p.org_id,p.target_kind,p.target_id) RETURNING q.*;
END $$;
CREATE FUNCTION inbox_maintained.finish_work(token uuid,candidate jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o uuid:=(candidate->>'org_id')::uuid;k text:=candidate->>'target_kind';t uuid:=(candidate->>'target_id')::uuid;
 q inbox_maintained.queue%ROWTYPE;g bigint;result text;ack bigint;
BEGIN
 -- Match source-trigger lock order. The queue claim transaction ended before compute.
 SELECT generation INTO g FROM inbox_message_capture.dirty WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF NOT FOUND THEN RETURN 'missing_target';END IF;
 SELECT * INTO q FROM inbox_maintained.queue WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF NOT FOUND OR token IS NULL OR q.claim_token IS DISTINCT FROM token OR q.lease_until<=clock_timestamp() THEN RETURN 'stale_claim';END IF;
 result:=inbox_maintained.publish(candidate);
 SELECT source_generation INTO ack FROM inbox_maintained.rows WHERE org_id=o AND target_kind=k AND target_id=t;
 IF result IN ('applied','already_applied') AND ack=g THEN
 DELETE FROM inbox_maintained.queue WHERE org_id=o AND target_kind=k AND target_id=t;
 ELSE
 UPDATE inbox_maintained.queue SET claim_token=NULL,lease_until=NULL,available_at=statement_timestamp()+interval '100 milliseconds' WHERE org_id=o AND target_kind=k AND target_id=t;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_maintained FROM PUBLIC,anon,authenticated,service_role;


-- Component parent_capture; pinned 841dd151a0a5e2ea623d4ac2c936e097d45af190383e906ad1184fb6d58c53b3
-- Offline owned fixture only; no production migration or backfill claim.

SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';

CREATE SCHEMA inbox_parent AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_parent FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_parent.work(
 org_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('property','contact')),entity_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),ack bigint NOT NULL DEFAULT 0 CHECK(ack>=0 AND ack<=generation),
 scan_generation bigint,stream text CHECK(stream IN ('messages','reviews')),cursor uuid,
 claim_token uuid,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(org_id,kind,entity_id),CHECK((claim_token IS NULL)=(lease_until IS NULL)),
 CHECK((scan_generation IS NULL)=(stream IS NULL)),CHECK(scan_generation IS NULL OR (scan_generation>ack AND scan_generation<=generation))
);
CREATE INDEX parent_pending ON inbox_parent.work(available_at,org_id,kind,entity_id) WHERE generation>ack;
-- Fixture-only index candidates; production requires migration/capacity review.
-- Canonical index moved to separately executed concurrent-index packet.
-- Canonical index moved to separately executed concurrent-index packet.
-- Canonical index moved to separately executed concurrent-index packet.
CREATE FUNCTION inbox_parent.capture_parent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed boolean:=true;sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='properties' THEN
   changed:=(OLD.id,OLD.org_id,OLD.address,OLD.city,OLD.state,OLD.status,OLD.outreach_dispo,OLD.is_dnc_locked,OLD.assigned_user_id,OLD.needs_human_attention)
    IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.address,NEW.city,NEW.state,NEW.status,NEW.outreach_dispo,NEW.is_dnc_locked,NEW.assigned_user_id,NEW.needs_human_attention);
  ELSE
   changed:=(OLD.id,OLD.org_id,OLD.entity_name,OLD.first_name,OLD.last_name,OLD.do_not_contact,OLD.sms_opted_out)
    IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.entity_name,NEW.first_name,NEW.last_name,NEW.do_not_contact,NEW.sms_opted_out);
  END IF;
 END IF;
 IF NOT changed THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('org',NEW.org_id,'id',NEW.id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.id)) ELSE jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.id),jsonb_build_object('org',NEW.org_id,'id',NEW.id)) END;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid o,(value->>'id')::uuid id FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_parent.work(org_id,kind,entity_id,generation) VALUES(k.o,TG_ARGV[0],k.id,1)
  ON CONFLICT(org_id,kind,entity_id) DO UPDATE SET generation=inbox_parent.work.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_parent AFTER INSERT OR UPDATE OR DELETE ON public.properties FOR EACH ROW EXECUTE FUNCTION inbox_parent.capture_parent('property');
CREATE TRIGGER zzzzz_inbox_parent AFTER INSERT OR UPDATE OR DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION inbox_parent.capture_parent('contact');
CREATE FUNCTION inbox_parent.capture_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.conversation_id,OLD.property_id,OLD.status,OLD.disposition,OLD.source_inbound_message_id,OLD.created_at)
 IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id,NEW.property_id,NEW.status,NEW.disposition,NEW.source_inbound_message_id,NEW.created_at) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('org',NEW.org_id,'id',NEW.conversation_id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.conversation_id)) ELSE jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.conversation_id),jsonb_build_object('org',NEW.org_id,'id',NEW.conversation_id)) END;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid o,(value->>'id')::uuid id FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_message_capture.dirty VALUES(k.o,'known_conversation',k.id,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_parent_review AFTER INSERT OR UPDATE OR DELETE ON public.ai_disposition_reviews FOR EACH ROW EXECUTE FUNCTION inbox_parent.capture_review();
CREATE FUNCTION inbox_parent.claim(p_limit integer DEFAULT 10,p_seconds integer DEFAULT 30) RETURNS SETOF inbox_parent.work LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_seconds IS NULL OR p_seconds<1 OR p_seconds>300 THEN RAISE EXCEPTION 'Invalid claim bounds';END IF;
 RETURN QUERY WITH picked AS(SELECT org_id,kind,entity_id FROM inbox_parent.work WHERE generation>ack AND available_at<=statement_timestamp() ORDER BY available_at,org_id,kind,entity_id LIMIT p_limit FOR UPDATE SKIP LOCKED)
 UPDATE inbox_parent.work w SET claim_token=gen_random_uuid(),lease_until=statement_timestamp()+make_interval(secs=>p_seconds),available_at=statement_timestamp()+make_interval(secs=>p_seconds),scan_generation=coalesce(w.scan_generation,w.generation),stream=coalesce(w.stream,'messages') FROM picked p WHERE (w.org_id,w.kind,w.entity_id)=(p.org_id,p.kind,p.entity_id) RETURNING w.*;
END $$;
CREATE FUNCTION inbox_parent.batch(o uuid,k text,e uuid,token uuid,p_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE before inbox_parent.work%ROWTYPE;locked inbox_parent.work%ROWTYPE;links jsonb;child record;n integer;last_id uuid;result text;source_sql text;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid batch bound';END IF;
 -- MVCC source reads occur before any private write locks. No canonical row locks.
 SELECT * INTO before FROM inbox_parent.work WHERE org_id=o AND kind=k AND entity_id=e;
 IF NOT FOUND OR token IS NULL OR before.claim_token IS DISTINCT FROM token OR before.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('result','stale_claim');END IF;
 IF before.stream='reviews' THEN
  source_sql:='SELECT id,conversation_id FROM public.ai_disposition_reviews WHERE org_id=$1 AND property_id=$2';
 ELSIF k='property' THEN
  source_sql:='SELECT id,CASE WHEN channel=''sms'' THEN conversation_id END AS conversation_id FROM public.messages WHERE org_id=$1 AND property_id=$2';
 ELSE
  source_sql:='SELECT id,CASE WHEN channel=''sms'' THEN conversation_id END AS conversation_id FROM public.messages WHERE org_id=$1 AND contact_id=$2';
 END IF;
 -- Separate first/cursor shapes; avoid a generic OR plan scanning a deep prefix.
 IF before.cursor IS NOT NULL THEN source_sql:=source_sql||' AND id>$3';END IF;
 EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),''[]''::jsonb) FROM ('||source_sql||' ORDER BY id LIMIT $4) s' INTO links USING o,e,before.cursor,p_limit;
 n:=jsonb_array_length(links);last_id:=(links->(n-1)->>'id')::uuid;
 BEGIN
  -- Child before parent, matching nested legacy property->review dirty->parent capture.
  -- A failed fence rolls back all child enqueues in this subtransaction.
  FOR child IN SELECT DISTINCT (value->>'conversation_id')::uuid id FROM jsonb_array_elements(links) WHERE value->>'conversation_id' IS NOT NULL ORDER BY 1 LOOP
   INSERT INTO inbox_message_capture.dirty VALUES(o,'known_conversation',child.id,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;
  END LOOP;
  SELECT * INTO locked FROM inbox_parent.work WHERE org_id=o AND kind=k AND entity_id=e FOR UPDATE;
  IF NOT FOUND OR locked.claim_token IS DISTINCT FROM token OR locked.lease_until<=clock_timestamp() OR (locked.scan_generation,locked.stream,locked.cursor) IS DISTINCT FROM (before.scan_generation,before.stream,before.cursor) THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale parent checkpoint';END IF;
  IF n=p_limit THEN
   UPDATE inbox_parent.work SET cursor=last_id WHERE org_id=o AND kind=k AND entity_id=e;result:='advanced';
  ELSIF k='property' AND before.stream='messages' THEN
   UPDATE inbox_parent.work SET stream='reviews',cursor=NULL WHERE org_id=o AND kind=k AND entity_id=e;result:='next_stream';
  ELSE
   UPDATE inbox_parent.work SET ack=before.scan_generation,scan_generation=NULL,stream=NULL,cursor=NULL WHERE org_id=o AND kind=k AND entity_id=e;result:='completed';
  END IF;
  UPDATE inbox_parent.work SET claim_token=NULL,lease_until=NULL,available_at=statement_timestamp() WHERE org_id=o AND kind=k AND entity_id=e;
 EXCEPTION WHEN SQLSTATE 'P0002' THEN RETURN jsonb_build_object('result','stale_claim');
 END;
 RETURN jsonb_build_object('result',result,'source_rows',n,'scan_generation',before.scan_generation::text);
END $$;
ALTER TABLE inbox_parent.work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_parent FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_parent FROM PUBLIC,anon,authenticated,service_role;


-- Component safety_capture; pinned 0e42f835e29d3aa34e41ead32fa5daf80eb5d59e1aa182b547bd5cde2e0cbbc5
-- Owned isolated fixture only. Summary invalidation, not command-policy versions.

SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';

CREATE SCHEMA inbox_safety AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_safety FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_safety.routes(
 org_id uuid NOT NULL,phone_e164 text NOT NULL, generation bigint NOT NULL CHECK(generation>0),
 ack bigint NOT NULL DEFAULT 0 CHECK(ack>=0 AND ack<=generation),scan_generation bigint,cursor uuid,
 claim_token uuid,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(org_id,phone_e164),CHECK((claim_token IS NULL)=(lease_until IS NULL)),
 CHECK(scan_generation IS NULL OR (scan_generation>ack AND scan_generation<=generation))
);
CREATE INDEX route_pending ON inbox_safety.routes(available_at,org_id,phone_e164) WHERE generation>ack;
CREATE FUNCTION inbox_safety.consent_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.contact_id,OLD.channel,OLD.event_type,OLD.occurred_at) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.contact_id,NEW.channel,NEW.event_type,NEW.occurred_at) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'c',NEW.contact_id,'channel',NEW.channel,'event',NEW.event_type)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.contact_id,'channel',OLD.channel,'event',OLD.event_type)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.contact_id,'channel',OLD.channel,'event',OLD.event_type),jsonb_build_object('o',NEW.org_id,'c',NEW.contact_id,'channel',NEW.channel,'event',NEW.event_type)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,(value->>'c')::uuid c FROM jsonb_array_elements(sides) WHERE value->>'channel'='sms' AND value->>'event' IN ('opt_in_marketing_written','opt_in_informational','opt_in_confirmed','opt_out','provider_auto_opt_out') ORDER BY 1,2 LOOP
  INSERT INTO inbox_parent.work(org_id,kind,entity_id,generation) VALUES(k.o,'contact',k.c,1) ON CONFLICT(org_id,kind,entity_id) DO UPDATE SET generation=inbox_parent.work.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_safety_consent AFTER INSERT OR UPDATE OR DELETE ON public.consent_events FOR EACH ROW EXECUTE FUNCTION inbox_safety.consent_capture();
CREATE FUNCTION inbox_safety.thread_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.org_id,OLD.conversation_id,OLD.ai_responder_status) IS NOT DISTINCT FROM (NEW.org_id,NEW.conversation_id,NEW.ai_responder_status) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id),jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,(value->>'c')::uuid c FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_message_capture.dirty VALUES(k.o,'known_conversation',k.c,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_safety_thread AFTER INSERT OR UPDATE OR DELETE ON public.message_threads FOR EACH ROW EXECUTE FUNCTION inbox_safety.thread_capture();
CREATE FUNCTION inbox_safety.suppression_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.org_id,OLD.channel,OLD.phone_e164) IS NOT DISTINCT FROM (NEW.org_id,NEW.channel,NEW.phone_e164) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'p',NEW.phone_e164,'channel',NEW.channel)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'p',OLD.phone_e164,'channel',OLD.channel)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'p',OLD.phone_e164,'channel',OLD.channel),jsonb_build_object('o',NEW.org_id,'p',NEW.phone_e164,'channel',NEW.channel)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,value->>'p' p FROM jsonb_array_elements(sides) WHERE value->>'channel'='sms' ORDER BY 1,2 LOOP
  INSERT INTO inbox_safety.routes(org_id,phone_e164,generation) VALUES(k.o,k.p,1) ON CONFLICT(org_id,phone_e164) DO UPDATE SET generation=inbox_safety.routes.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_safety_suppression AFTER INSERT OR UPDATE OR DELETE ON public.sms_phone_suppressions FOR EACH ROW EXECUTE FUNCTION inbox_safety.suppression_capture();
CREATE FUNCTION inbox_safety.claim(p_limit integer DEFAULT 10,p_seconds integer DEFAULT 30) RETURNS SETOF inbox_safety.routes LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_seconds IS NULL OR p_seconds<1 OR p_seconds>300 THEN RAISE EXCEPTION 'Invalid claim bounds';END IF;
 RETURN QUERY WITH picked AS(SELECT org_id,phone_e164 FROM inbox_safety.routes WHERE generation>ack AND available_at<=statement_timestamp() ORDER BY available_at,org_id,phone_e164 LIMIT p_limit FOR UPDATE SKIP LOCKED)
 UPDATE inbox_safety.routes w SET claim_token=gen_random_uuid(),lease_until=statement_timestamp()+make_interval(secs=>p_seconds),available_at=statement_timestamp()+make_interval(secs=>p_seconds),scan_generation=coalesce(w.scan_generation,w.generation) FROM picked p WHERE (w.org_id,w.phone_e164)=(p.org_id,p.phone_e164) RETURNING w.*;
END $$;
CREATE FUNCTION inbox_safety.batch(o uuid,p text,token uuid,p_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE before inbox_safety.routes%ROWTYPE;locked inbox_safety.routes%ROWTYPE;links jsonb;child record;n integer;last_id uuid;result text;source_sql text;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid batch bounds';END IF;
 SELECT * INTO before FROM inbox_safety.routes WHERE org_id=o AND phone_e164=p;
 IF NOT FOUND OR token IS NULL OR before.claim_token IS DISTINCT FROM token OR before.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('result','stale_claim');END IF;
 source_sql:='SELECT message_id,conversation_id FROM inbox_message_capture.route_edges WHERE org_id=$1 AND phone_e164=$2';
 IF before.cursor IS NOT NULL THEN source_sql:=source_sql||' AND message_id>$3';END IF;
 EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.message_id),''[]''::jsonb) FROM ('||source_sql||' ORDER BY message_id LIMIT $4) s' INTO links USING o,p,before.cursor,p_limit;
 n:=jsonb_array_length(links);last_id:=(links->(n-1)->>'message_id')::uuid;
 BEGIN
  FOR child IN SELECT DISTINCT (value->>'conversation_id')::uuid c FROM jsonb_array_elements(links) ORDER BY 1 LOOP
   INSERT INTO inbox_message_capture.dirty VALUES(o,'known_conversation',child.c,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;
  END LOOP;
  SELECT * INTO locked FROM inbox_safety.routes WHERE org_id=o AND phone_e164=p FOR UPDATE;
  IF NOT FOUND OR locked.claim_token IS DISTINCT FROM token OR locked.lease_until<=clock_timestamp() OR (locked.scan_generation,locked.cursor) IS DISTINCT FROM (before.scan_generation,before.cursor) THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale route checkpoint';END IF;
  IF n=p_limit THEN UPDATE inbox_safety.routes SET cursor=last_id WHERE org_id=o AND phone_e164=p;result:='advanced';
  ELSE UPDATE inbox_safety.routes SET ack=before.scan_generation,scan_generation=NULL,cursor=NULL WHERE org_id=o AND phone_e164=p;result:='completed';END IF;
  UPDATE inbox_safety.routes SET claim_token=NULL,lease_until=NULL,available_at=statement_timestamp() WHERE org_id=o AND phone_e164=p;
 EXCEPTION WHEN SQLSTATE 'P0002' THEN RETURN jsonb_build_object('result','stale_claim');END;
 RETURN jsonb_build_object('result',result,'source_rows',n,'scan_generation',before.scan_generation::text);
END $$;
ALTER TABLE inbox_safety.routes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_safety FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_safety FROM PUBLIC,anon,authenticated,service_role;


-- Component backfill; pinned d7ff8e2f2c39328a8b25e04fdde9e6fe201ea5f721158789ef4d37820e9ed4d0
-- Owned fixture historical backfill rehearsal, not a production migration.

SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';

CREATE SCHEMA inbox_backfill AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_backfill FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_backfill.jobs(
 org_id uuid PRIMARY KEY,stream text NOT NULL DEFAULT 'messages' CHECK(stream IN ('messages','reviews','threads','done')),
 cursor uuid,revision bigint NOT NULL DEFAULT 0,claim_token uuid,lease_until timestamptz,
 available_at timestamptz NOT NULL DEFAULT statement_timestamp(),capture_fingerprint text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT statement_timestamp(),completed_at timestamptz,
 CHECK((claim_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX backfill_available ON inbox_backfill.jobs(available_at,org_id) WHERE stream<>'done';
CREATE TABLE inbox_backfill.collisions(
 org_id uuid NOT NULL,conversation_id uuid NOT NULL,generation bigint NOT NULL DEFAULT 1,ack bigint NOT NULL DEFAULT 0,
 duplicate_thread_ids uuid[],checked_at timestamptz,PRIMARY KEY(org_id,conversation_id),CHECK(ack>=0 AND ack<=generation)
);
CREATE INDEX collision_pending ON inbox_backfill.collisions(org_id,conversation_id) WHERE generation>ack;
-- Canonical index moved to separately executed concurrent-index packet.
-- Canonical index moved to separately executed concurrent-index packet.
-- Canonical index moved to separately executed concurrent-index packet.
-- Canonical index moved to separately executed concurrent-index packet.
CREATE FUNCTION inbox_backfill.capture_collision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.conversation_id) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id),jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,(value->>'c')::uuid c FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_backfill.collisions(org_id,conversation_id) VALUES(k.o,k.c) ON CONFLICT(org_id,conversation_id) DO UPDATE SET generation=inbox_backfill.collisions.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_backfill_collision AFTER INSERT OR UPDATE OR DELETE ON public.message_threads FOR EACH ROW EXECUTE FUNCTION inbox_backfill.capture_collision();
CREATE FUNCTION inbox_backfill.fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT md5(string_agg(t.tgrelid::regclass::text||':'||t.tgname||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid)||':'||pg_get_functiondef(t.tgfoid),'|' ORDER BY t.tgrelid,t.tgname))
 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname IN ('zzzzz_inbox_message_direct','zzzzz_inbox_parent','zzzzz_inbox_parent_review','zzzzz_inbox_safety_consent','zzzzz_inbox_safety_thread','zzzzz_inbox_safety_suppression','zzzzz_inbox_backfill_collision');
$$;
CREATE FUNCTION inbox_backfill.start(o uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF o IS NULL OR NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=o) THEN RAISE EXCEPTION 'Invalid organization';END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND tgname IN ('zzzzz_inbox_message_direct','zzzzz_inbox_parent','zzzzz_inbox_parent_review','zzzzz_inbox_safety_consent','zzzzz_inbox_safety_thread','zzzzz_inbox_safety_suppression','zzzzz_inbox_backfill_collision'))<>8 THEN RAISE EXCEPTION 'Required capture trigger set absent';END IF;
 INSERT INTO inbox_backfill.jobs(org_id,capture_fingerprint) VALUES(o,inbox_backfill.fingerprint());
END $$;
CREATE FUNCTION inbox_backfill.claim(p_limit integer DEFAULT 10,p_seconds integer DEFAULT 30) RETURNS SETOF inbox_backfill.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_seconds IS NULL OR p_seconds<1 OR p_seconds>300 THEN RAISE EXCEPTION 'Invalid claim bounds';END IF;
 RETURN QUERY WITH picked AS(SELECT org_id FROM inbox_backfill.jobs WHERE stream<>'done' AND available_at<=statement_timestamp() ORDER BY available_at,org_id LIMIT p_limit FOR UPDATE SKIP LOCKED)
 UPDATE inbox_backfill.jobs j SET claim_token=gen_random_uuid(),lease_until=statement_timestamp()+make_interval(secs=>p_seconds),available_at=statement_timestamp()+make_interval(secs=>p_seconds) FROM picked p WHERE j.org_id=p.org_id RETURNING j.*;
END $$;
CREATE FUNCTION inbox_backfill.batch(o uuid,token uuid,p_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE before inbox_backfill.jobs%ROWTYPE;locked inbox_backfill.jobs%ROWTYPE;rows jsonb;targets jsonb:='[]';r jsonb;k record;n integer;last_id uuid;group_id uuid;phone text;source_sql text;next_stream text;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid batch bound';END IF;
 SELECT * INTO before FROM inbox_backfill.jobs WHERE org_id=o;
 IF NOT FOUND OR token IS NULL OR before.claim_token IS DISTINCT FROM token OR before.lease_until<=clock_timestamp() OR before.stream='done' THEN RETURN jsonb_build_object('result','stale_claim');END IF;
 IF before.capture_fingerprint IS DISTINCT FROM inbox_backfill.fingerprint() THEN RAISE EXCEPTION 'Capture fingerprint changed';END IF;
 BEGIN
  -- Lock the entire bounded source page before any registry/dirty/edge writes.
  -- No SKIP LOCKED: a locked historical row must retry, never disappear behind a cursor.
  source_sql:=CASE before.stream WHEN 'messages' THEN 'SELECT id,org_id,conversation_id,contact_id,channel,direction,from_address,to_address FROM public.messages WHERE org_id=$1' WHEN 'reviews' THEN 'SELECT id,org_id,conversation_id FROM public.ai_disposition_reviews WHERE org_id=$1' ELSE 'SELECT id,org_id,conversation_id FROM public.message_threads WHERE org_id=$1' END;
  IF before.cursor IS NOT NULL THEN source_sql:=source_sql||' AND id>$2';END IF;
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),''[]''::jsonb) FROM ('||source_sql||' ORDER BY id LIMIT $3 FOR UPDATE) s' INTO rows USING o,before.cursor,p_limit;
  n:=jsonb_array_length(rows);last_id:=(rows->(n-1)->>'id')::uuid;
  IF before.stream='messages' THEN
   -- Raw bucket locks precede dirty/edge writes, as in the source capture trigger.
   FOR r IN SELECT value FROM jsonb_array_elements(rows) ORDER BY md5(value->>'from_address'),(value->>'from_address') COLLATE "C" LOOP
    IF r->>'channel'='sms' AND r->>'conversation_id' IS NOT NULL THEN targets:=targets||jsonb_build_array(jsonb_build_object('kind','known_conversation','id',r->>'conversation_id'));END IF;
    IF r->>'channel'='sms' AND r->>'direction'='inbound' AND r->>'contact_id' IS NULL AND r->>'from_address' IS NOT NULL AND r->>'from_address'<>'' THEN
     group_id:=inbox_message_capture.sender_id(o,r->>'from_address');targets:=targets||jsonb_build_array(jsonb_build_object('kind','unknown_sender','id',group_id));
    END IF;
   END LOOP;
  ELSE
   SELECT coalesce(jsonb_agg(jsonb_build_object('kind','known_conversation','id',value->>'conversation_id')),'[]') INTO targets FROM jsonb_array_elements(rows);
  END IF;
  FOR k IN SELECT DISTINCT value->>'kind' kind,(value->>'id')::uuid id FROM jsonb_array_elements(targets) ORDER BY 1,2 LOOP
   INSERT INTO inbox_message_capture.dirty VALUES(o,k.kind,k.id,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;
  END LOOP;
  IF before.stream='messages' THEN
   FOR r IN SELECT value FROM jsonb_array_elements(rows) ORDER BY value->>'id' LOOP
    DELETE FROM inbox_message_capture.route_edges WHERE org_id=o AND message_id=(r->>'id')::uuid;
    IF r->>'channel'='sms' AND r->>'conversation_id' IS NOT NULL THEN
     phone:=regexp_replace(coalesce(CASE WHEN r->>'direction'='inbound' THEN r->>'from_address' ELSE r->>'to_address' END,''),'[^0-9]','','g');
     phone:=CASE WHEN length(phone)=10 THEN '+1'||phone WHEN length(phone)=11 AND left(phone,1)='1' THEN '+'||phone ELSE NULL END;
     IF phone IS NOT NULL THEN INSERT INTO inbox_message_capture.route_edges VALUES(o,(r->>'id')::uuid,(r->>'conversation_id')::uuid,phone);END IF;
    END IF;
   END LOOP;
  ELSIF before.stream='threads' THEN
   FOR k IN SELECT DISTINCT (value->>'conversation_id')::uuid id FROM jsonb_array_elements(rows) ORDER BY 1 LOOP
    INSERT INTO inbox_backfill.collisions(org_id,conversation_id) VALUES(o,k.id) ON CONFLICT(org_id,conversation_id) DO UPDATE SET generation=inbox_backfill.collisions.generation+1;
   END LOOP;
  END IF;
  SELECT * INTO locked FROM inbox_backfill.jobs WHERE org_id=o FOR UPDATE;
  IF NOT FOUND OR locked.claim_token IS DISTINCT FROM token OR locked.lease_until<=clock_timestamp() OR (locked.revision,locked.stream,locked.cursor) IS DISTINCT FROM (before.revision,before.stream,before.cursor) THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Stale backfill checkpoint';END IF;
  next_stream:=CASE WHEN n=p_limit THEN before.stream WHEN before.stream='messages' THEN 'reviews' WHEN before.stream='reviews' THEN 'threads' ELSE 'done' END;
  UPDATE inbox_backfill.jobs SET stream=next_stream,cursor=CASE WHEN n=p_limit THEN last_id END,revision=revision+1,claim_token=NULL,lease_until=NULL,available_at=statement_timestamp(),completed_at=CASE WHEN next_stream='done' THEN statement_timestamp() END WHERE org_id=o;
 EXCEPTION WHEN SQLSTATE 'P0002' THEN RETURN jsonb_build_object('result','stale_claim');END;
 RETURN jsonb_build_object('result','advanced','source_rows',n,'stream',next_stream);
END $$;
CREATE FUNCTION inbox_backfill.inspect_collisions(o uuid,p_limit integer DEFAULT 100) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE candidate record;ids uuid[];processed integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid collision bound';END IF;
 FOR candidate IN SELECT * FROM inbox_backfill.collisions WHERE org_id=o AND generation>ack ORDER BY conversation_id LIMIT p_limit LOOP
  -- Read-only two-row index probe, no canonical locks while private state is locked.
  SELECT array_agg(id ORDER BY id) INTO ids FROM(SELECT id FROM public.message_threads WHERE org_id=o AND conversation_id=candidate.conversation_id ORDER BY id LIMIT 2) s;
  UPDATE inbox_backfill.collisions SET ack=candidate.generation,duplicate_thread_ids=CASE WHEN cardinality(ids)=2 THEN ids END,checked_at=statement_timestamp() WHERE org_id=o AND conversation_id=candidate.conversation_id AND ack<candidate.generation;
  processed:=processed+1;
 END LOOP;
 RETURN processed;
END $$;
CREATE FUNCTION inbox_backfill.readiness(o uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('historical_scan_complete',j.stream='done','capture_unchanged',j.capture_fingerprint=inbox_backfill.fingerprint(),
 'collision_checks_pending',EXISTS(SELECT 1 FROM inbox_backfill.collisions WHERE org_id=o AND generation>ack),
 'thread_collision_found',EXISTS(SELECT 1 FROM inbox_backfill.collisions WHERE org_id=o AND cardinality(duplicate_thread_ids)=2),
 'production_cutover_authorized',false) FROM inbox_backfill.jobs j WHERE j.org_id=o;
$$;
ALTER TABLE inbox_backfill.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_backfill.collisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_backfill FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_backfill FROM PUBLIC,anon,authenticated,service_role;


-- Component policy; pinned ae524b76ebbd24295e6145c33fe100208299523b5145c61019e132a19f01d4d1
-- Worker-private action dependency counters; not a production migration or send authorization.

SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';

CREATE SCHEMA inbox_policy AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_policy FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_policy.versions(
 org_id uuid NOT NULL,namespace text NOT NULL CHECK(namespace IN ('property_identity','property_policy','property_outcome','property_assignment','property_reply_content','contact_identity','contact_policy','contact_reply_content','contact_channel_consent','route_policy','conversation_identity','review_action','property_reviews','membership_access')),entity_key text NOT NULL CHECK(length(entity_key)<=256),
 revision bigint NOT NULL CHECK(revision>0),PRIMARY KEY(org_id,namespace,entity_key)
);
-- Persistent counters have no canonical FK and are never removed on entity deletion.
CREATE FUNCTION inbox_policy.validate_key(ns text,k jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE expected integer;
BEGIN
 IF ns IS NULL OR ns NOT IN ('property_identity','property_policy','property_outcome','property_assignment','property_reply_content','contact_identity','contact_policy','contact_reply_content','contact_channel_consent','route_policy','conversation_identity','review_action','property_reviews','membership_access') THEN RAISE EXCEPTION 'Invalid dependency namespace';END IF;
 IF jsonb_typeof(k) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid typed dependency key';END IF;
 expected:=CASE WHEN ns IN ('contact_channel_consent','route_policy') THEN 2 ELSE 1 END;
 IF jsonb_array_length(k)<>expected THEN RAISE EXCEPTION 'Invalid typed dependency key';END IF;
 IF ns='route_policy' THEN
  IF k->>0 IS DISTINCT FROM 'sms' OR jsonb_typeof(k->1) IS DISTINCT FROM 'string' OR (k->>1)!~'^\+[1-9][0-9]{7,14}$' THEN RAISE EXCEPTION 'Invalid typed route key';END IF;
 ELSE
  IF jsonb_typeof(k->0) IS DISTINCT FROM 'string' OR (k->>0)!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid typed entity key';END IF;
  IF ns='contact_channel_consent' AND (k->>1 IS NULL OR k->>1 NOT IN ('sms','email','voice')) THEN RAISE EXCEPTION 'Invalid typed consent channel';END IF;
 END IF;
END $$;
CREATE FUNCTION inbox_policy.bump(events jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE k record;event jsonb;
BEGIN
 IF jsonb_typeof(events) IS DISTINCT FROM 'array' OR jsonb_array_length(events)>32 THEN RAISE EXCEPTION 'Invalid bounded dependency events';END IF;
 FOR event IN SELECT value FROM jsonb_array_elements(events) LOOP
  IF jsonb_typeof(event) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid dependency event';END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(event))<>3 OR NOT(event ?& ARRAY['org','namespace','key']) OR jsonb_typeof(event->'org') IS DISTINCT FROM 'string' OR (event->>'org')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid dependency event';END IF;
  PERFORM inbox_policy.validate_key(event->>'namespace',event->'key');
 END LOOP;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid org,value->>'namespace' namespace,(value->'key')::text entity_key FROM jsonb_array_elements(events) ORDER BY 1,2,3 LOOP
  INSERT INTO inbox_policy.versions VALUES(k.org,k.namespace,k.entity_key,1) ON CONFLICT(org_id,namespace,entity_key) DO UPDATE SET revision=inbox_policy.versions.revision+1;
 END LOOP;
END $$;
CREATE FUNCTION inbox_policy.capture_properties() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.deleted_at,OLD.homeowner_contact_id,OLD.agent_contact_id) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.deleted_at,NEW.homeowner_contact_id,NEW.agent_contact_id);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_identity','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_identity','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.status,OLD.is_dnc_locked,OLD.is_training) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.status,NEW.is_dnc_locked,NEW.is_training);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_policy','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_policy','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.outreach_dispo) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.outreach_dispo);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_outcome','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_outcome','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.assigned_user_id,OLD.follow_up_at) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.assigned_user_id,NEW.follow_up_at);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_assignment','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_assignment','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.address,OLD.city,OLD.state,OLD.zip) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.address,NEW.city,NEW.state,NEW.zip);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_reply_content','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_reply_content','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.properties FOR EACH ROW EXECUTE FUNCTION inbox_policy.capture_properties();
CREATE FUNCTION inbox_policy.capture_contacts() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id) IS DISTINCT FROM (NEW.id,NEW.org_id);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','contact_identity','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','contact_identity','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.do_not_contact,OLD.sms_opted_out,OLD.phone_1,OLD.phone_2,OLD.phone_3,OLD.phone_1_type,OLD.phone_2_type,OLD.phone_3_type) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.do_not_contact,NEW.sms_opted_out,NEW.phone_1,NEW.phone_2,NEW.phone_3,NEW.phone_1_type,NEW.phone_2_type,NEW.phone_3_type);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','contact_policy','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','contact_policy','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.first_name,OLD.last_name,OLD.entity_name) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.first_name,NEW.last_name,NEW.entity_name);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','contact_reply_content','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','contact_reply_content','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION inbox_policy.capture_contacts();
CREATE FUNCTION inbox_policy.capture_consent_events() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.contact_id,OLD.channel,OLD.event_type,OLD.occurred_at) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.contact_id,NEW.channel,NEW.event_type,NEW.occurred_at);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','contact_channel_consent','key',jsonb_build_array(OLD.contact_id,OLD.channel)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','contact_channel_consent','key',jsonb_build_array(NEW.contact_id,NEW.channel)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.consent_events FOR EACH ROW EXECUTE FUNCTION inbox_policy.capture_consent_events();
CREATE FUNCTION inbox_policy.capture_sms_phone_suppressions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.channel,OLD.phone_e164,OLD.suppressed_at) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.channel,NEW.phone_e164,NEW.suppressed_at);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','route_policy','key',jsonb_build_array(OLD.channel,OLD.phone_e164)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','route_policy','key',jsonb_build_array(NEW.channel,NEW.phone_e164)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.sms_phone_suppressions FOR EACH ROW EXECUTE FUNCTION inbox_policy.capture_sms_phone_suppressions();
CREATE FUNCTION inbox_policy.capture_message_threads() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','conversation_identity','key',jsonb_build_array(OLD.conversation_id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','conversation_identity','key',jsonb_build_array(NEW.conversation_id)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.message_threads FOR EACH ROW EXECUTE FUNCTION inbox_policy.capture_message_threads();
CREATE FUNCTION inbox_policy.capture_ai_disposition_reviews() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.property_id,OLD.conversation_id,OLD.status,OLD.disposition,OLD.source_inbound_message_id) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.property_id,NEW.conversation_id,NEW.status,NEW.disposition,NEW.source_inbound_message_id);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','review_action','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','review_action','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.property_id,OLD.conversation_id,OLD.status,OLD.disposition,OLD.source_inbound_message_id) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.property_id,NEW.conversation_id,NEW.status,NEW.disposition,NEW.source_inbound_message_id);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_reviews','key',jsonb_build_array(OLD.property_id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_reviews','key',jsonb_build_array(NEW.property_id)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.ai_disposition_reviews FOR EACH ROW EXECUTE FUNCTION inbox_policy.capture_ai_disposition_reviews();
CREATE FUNCTION inbox_policy.capture_memberships() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.user_id,OLD.role,OLD.access_status,OLD.access_expires_at,OLD.deletion_prepared_at,OLD.deletion_operation_id,OLD.hugo_config,OLD.acquisitions_enabled) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.user_id,NEW.role,NEW.access_status,NEW.access_expires_at,NEW.deletion_prepared_at,NEW.deletion_operation_id,NEW.hugo_config,NEW.acquisitions_enabled);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','membership_access','key',jsonb_build_array(OLD.user_id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','membership_access','key',jsonb_build_array(NEW.user_id)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.memberships FOR EACH ROW EXECUTE FUNCTION inbox_policy.capture_memberships();
CREATE FUNCTION inbox_policy.snapshot(o uuid,requirements jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;count_required integer;requirement jsonb;
BEGIN
 IF o IS NULL OR jsonb_typeof(requirements) IS DISTINCT FROM 'array' OR jsonb_array_length(requirements)<1 OR jsonb_array_length(requirements)>50 THEN RAISE EXCEPTION 'Invalid bounded dependency requirements';END IF;
 FOR requirement IN SELECT value FROM jsonb_array_elements(requirements) LOOP
  IF jsonb_typeof(requirement) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid dependency requirement';END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(requirement))<>2 OR NOT(requirement ?& ARRAY['namespace','key']) THEN RAISE EXCEPTION 'Invalid dependency requirement';END IF;
  PERFORM inbox_policy.validate_key(requirement->>'namespace',requirement->'key');
 END LOOP;
 SELECT count(*) INTO count_required FROM(SELECT DISTINCT value->>'namespace' namespace,(value->'key')::text entity_key FROM jsonb_array_elements(requirements)) s;
 IF count_required<>jsonb_array_length(requirements) THEN RAISE EXCEPTION 'Duplicate dependency';END IF;
 SELECT jsonb_agg(jsonb_build_object('namespace',v.namespace,'key',v.entity_key::jsonb,'revision',v.revision::text) ORDER BY v.namespace,v.entity_key) INTO result
 FROM jsonb_array_elements(requirements) r JOIN inbox_policy.versions v ON v.org_id=o AND v.namespace=r.value->>'namespace' AND v.entity_key=(r.value->'key')::text;
 IF coalesce(jsonb_array_length(result),0)<>count_required THEN RAISE EXCEPTION 'Unseeded dependency: authoritative baseline required';END IF;
 RETURN jsonb_build_object('org_id',o,'dependencies',result);
END $$;
ALTER TABLE inbox_policy.versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_policy FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_policy FROM PUBLIC,anon,authenticated,service_role;


-- Component projection; pinned 57cdc34ad11830ef5a0785f1b0a6b328505dfb5b96b959a8aee0481a0e2ac3e4
-- Owned fixture only. Narrow DTO projection; no publication is modified here.

SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';

CREATE SCHEMA inbox_bridge AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_bridge FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_bridge.summaries(
 org_id uuid NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('known_conversation','unknown_sender')),target_id uuid NOT NULL,
 projection_revision bigint NOT NULL,source_generation bigint NOT NULL,
 name text NOT NULL,context text NOT NULL,preview text NOT NULL,time_label text NOT NULL,outcome_label text NOT NULL,assigned_label text NOT NULL,unread boolean,
 latest_at timestamptz,visible_active boolean NOT NULL,visible_dismissed boolean NOT NULL,visible_review boolean NOT NULL,visible_unread boolean NOT NULL,
 PRIMARY KEY(org_id,target_kind,target_id),CHECK(length(name)<=2000 AND length(context)<=2000 AND length(preview)<=2000)
);
CREATE INDEX summary_order ON inbox_bridge.summaries(org_id,latest_at DESC,target_kind,target_id);
CREATE FUNCTION inbox_bridge.project() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s jsonb:=NEW.summary;unknown boolean:=NEW.target_kind='unknown_sender';
BEGIN
 IF s IS NULL OR (s->>'exists')::boolean IS DISTINCT FROM true THEN DELETE FROM inbox_bridge.summaries WHERE org_id=NEW.org_id AND target_kind=NEW.target_kind AND target_id=NEW.target_id;RETURN NULL;END IF;
 INSERT INTO inbox_bridge.summaries VALUES(NEW.org_id,NEW.target_kind,NEW.target_id,NEW.revision,NEW.source_generation,
 left(CASE WHEN unknown THEN coalesce(s->>'raw_sender_key','Unknown sender') ELSE coalesce(nullif(s->>'contact_name',''),s->>'thread_customer_phone','Unknown contact') END,2000),
 left(CASE WHEN unknown THEN 'Unknown sender' ELSE coalesce(s->>'property_address','No property linked') END,2000),
 left(coalesce(CASE WHEN unknown THEN s->>'latest_preview' ELSE s->>'last_message_preview' END,''),2000),
 coalesce(CASE WHEN unknown THEN s->>'latest_at' ELSE s->>'last_message_at' END,''),
 CASE WHEN unknown THEN CASE WHEN (s->>'is_dismissed')::boolean THEN 'Dismissed' ELSE 'Unknown sender' END ELSE coalesce(s->>'outreach_dispo','No outcome') END,
 CASE WHEN s->>'assigned_user_id' IS NULL THEN 'Unassigned' ELSE 'Assigned' END,
 CASE WHEN unknown THEN NULL ELSE coalesce((s->>'unread_count')::bigint,0)>0 END,
 (CASE WHEN unknown THEN s->>'latest_at' ELSE s->>'last_message_at' END)::timestamptz,
 CASE WHEN unknown THEN coalesce((s->>'visible_unknown')::boolean,false) ELSE coalesce((s->>'visible_all_hide_noise')::boolean,false) END,
 unknown AND coalesce((s->>'visible_dismissed')::boolean,false),NOT unknown AND coalesce((s->>'visible_review')::boolean,false),NOT unknown AND coalesce((s->>'visible_unread_hide_noise')::boolean,false))
 ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET projection_revision=excluded.projection_revision,source_generation=excluded.source_generation,name=excluded.name,context=excluded.context,preview=excluded.preview,time_label=excluded.time_label,outcome_label=excluded.outcome_label,assigned_label=excluded.assigned_label,unread=excluded.unread,latest_at=excluded.latest_at,visible_active=excluded.visible_active,visible_dismissed=excluded.visible_dismissed,visible_review=excluded.visible_review,visible_unread=excluded.visible_unread WHERE inbox_bridge.summaries.projection_revision<excluded.projection_revision;
 RETURN NULL;
END $$;
CREATE TRIGGER bridge_projection AFTER INSERT OR UPDATE OF summary,revision ON inbox_maintained.rows FOR EACH ROW EXECUTE FUNCTION inbox_bridge.project();
ALTER TABLE inbox_bridge.summaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_bridge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_bridge FROM PUBLIC,anon,authenticated,service_role;


-- Component auth; pinned cf675f9e1e034022f4dbadb591395b71814b856ed476a7a6a8cba4e1359dca1e
-- Canonical session subset modeled from schema-only deployed evidence; no Auth/JWT service claim.

SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';

DO $$ BEGIN IF to_regclass('auth.sessions') IS NULL THEN RAISE EXCEPTION 'Canonical fixture sessions subset missing';END IF;END $$;
CREATE TABLE inbox_bridge.access_epochs(user_id uuid PRIMARY KEY,revision bigint NOT NULL CHECK(revision>0));
CREATE FUNCTION inbox_bridge.capture_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed boolean:=true;users uuid[];u uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='sessions' THEN changed:=(OLD.id,OLD.user_id,OLD.not_after) IS DISTINCT FROM (NEW.id,NEW.user_id,NEW.not_after);
  ELSE changed:=(OLD.id,OLD.org_id,OLD.user_id,OLD.role,OLD.access_status,OLD.access_expires_at,OLD.deletion_prepared_at,OLD.deletion_operation_id,OLD.hugo_config,OLD.acquisitions_enabled) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.user_id,NEW.role,NEW.access_status,NEW.access_expires_at,NEW.deletion_prepared_at,NEW.deletion_operation_id,NEW.hugo_config,NEW.acquisitions_enabled);END IF;
 END IF;
 IF NOT changed THEN RETURN NULL;END IF;
 users:=CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.user_id] WHEN 'DELETE' THEN ARRAY[OLD.user_id] ELSE ARRAY[OLD.user_id,NEW.user_id] END;
 FOR u IN SELECT DISTINCT value FROM unnest(users) value ORDER BY 1 LOOP
  INSERT INTO inbox_bridge.access_epochs VALUES(u,1) ON CONFLICT(user_id) DO UPDATE SET revision=inbox_bridge.access_epochs.revision+1;
 END LOOP;RETURN NULL;
END $$;
CREATE TRIGGER zzzzzzz_inbox_access AFTER INSERT OR UPDATE OR DELETE ON public.memberships FOR EACH ROW EXECUTE FUNCTION inbox_bridge.capture_access();
CREATE TRIGGER zzzzzzz_inbox_access AFTER INSERT OR UPDATE OR DELETE ON auth.sessions FOR EACH ROW EXECUTE FUNCTION inbox_bridge.capture_access();
CREATE FUNCTION inbox_bridge.authorize(o uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=auth.uid();j jsonb:=auth.jwt();sid uuid;session_expiry timestamptz;claim_expiry timestamptz;membership jsonb;n integer;epoch bigint;expiry timestamptz;session_found boolean;checked_at timestamptz;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inbox_control.rollout WHERE singleton AND serving_enabled) THEN RAISE EXCEPTION 'INBOX_NOT_READY' USING ERRCODE='55000';END IF;
 IF u IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR jsonb_typeof(j->'session_id') IS DISTINCT FROM 'string' OR (j->>'session_id')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(j->>'exp','')!~'^[0-9]{1,12}$' THEN RAISE EXCEPTION 'INBOX_AUTH_REQUIRED' USING ERRCODE='42501';END IF;
 sid:=(j->>'session_id')::uuid;claim_expiry:=to_timestamp((j->>'exp')::double precision);
 IF claim_expiry<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_EXPIRED' USING ERRCODE='42501';END IF;
 checked_at:=clock_timestamp();
 -- One SQL snapshot supplies session, global membership count, selected row and epoch.
 -- Never combine a prior count with a later row/epoch after a concurrent membership commit.
 WITH active AS MATERIALIZED (
  SELECT m.org_id,m.access_expires_at FROM public.memberships m
  WHERE m.user_id=u AND m.access_status='active' AND m.deletion_prepared_at IS NULL
   AND (m.access_expires_at IS NULL OR m.access_expires_at>checked_at)
 ), membership_state AS (
  SELECT count(*)::integer AS total,jsonb_agg(to_jsonb(active)) AS rows FROM active
 )
 SELECT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=sid AND s.user_id=u),
  (SELECT s.not_after FROM auth.sessions s WHERE s.id=sid AND s.user_id=u),
  ms.total,ms.rows->0,(SELECT revision FROM inbox_bridge.access_epochs WHERE user_id=u)
 INTO session_found,session_expiry,n,membership,epoch FROM membership_state ms;
 IF NOT session_found OR session_expiry<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_REVOKED' USING ERRCODE='42501';END IF;
 IF n<>1 THEN RAISE EXCEPTION 'INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING' USING ERRCODE='42501';END IF;
 IF o IS NOT NULL AND (membership->>'org_id')::uuid IS DISTINCT FROM o THEN RAISE EXCEPTION 'INBOX_ORG_DENIED' USING ERRCODE='42501';END IF;
 IF epoch IS NULL THEN RAISE EXCEPTION 'INBOX_ACCESS_BASELINE_MISSING' USING ERRCODE='42501';END IF;
 expiry:=least(claim_expiry,session_expiry,(membership->>'access_expires_at')::timestamptz);
 IF expiry<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_EXPIRED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('user_id',u,'session_id',sid,'org_id',(membership->>'org_id')::uuid,'access_epoch',epoch::text,'expires_at',expiry,'session_active',true,'active_membership_count',n);
END $$;
ALTER TABLE inbox_bridge.access_epochs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_bridge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_bridge FROM PUBLIC,anon,authenticated,service_role;


-- Component worksets; pinned 52ecaf8d217f2f5554dc733305b81de646fb81cf721b9e044c4d2aa21c1fd3bb
-- Private owned-fixture worksets. JWT claims must be supplied only after signature verification.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';

CREATE TABLE inbox_bridge.worksets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,user_id uuid NOT NULL,session_id uuid NOT NULL,
 access_epoch bigint NOT NULL,generation bigint NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 filter jsonb NOT NULL,targets jsonb NOT NULL CHECK(jsonb_typeof(targets)='array' AND jsonb_array_length(targets)<=500),
 handles jsonb NOT NULL CHECK(jsonb_typeof(handles)='array' AND jsonb_array_length(handles)=greatest(1,(jsonb_array_length(targets)+99)/100)), revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX worksets_session ON inbox_bridge.worksets(user_id,session_id,created_at DESC);
CREATE FUNCTION inbox_bridge.scope_json(w inbox_bridge.worksets) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',w.id,'org_id',w.org_id,'user_id',w.user_id,'session_id',w.session_id,'access_epoch',w.access_epoch::text,'generation',w.generation::text,'created_at',w.created_at,'expires_at',w.expires_at,'targets',w.targets,'handles',w.handles);
$$;
CREATE FUNCTION inbox_bridge.create_scope(o uuid,f jsonb,n integer,replaces uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;u uuid;sid uuid;e bigint;now_at timestamptz;prior inbox_bridge.worksets;created inbox_bridge.worksets;ids jsonb;gen bigint;last_at timestamptz;view_name text;
BEGIN
 IF n IS NULL OR n<1 OR n>500 OR f IS NULL OR jsonb_typeof(f)<>'object' OR (f-'view')<>'{}'::jsonb OR jsonb_typeof(f->'view') IS DISTINCT FROM 'string' OR f->>'view' NOT IN ('active','dismissed','review','unread') THEN RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';END IF;
 a:=inbox_bridge.authorize(o);u:=(a->>'user_id')::uuid;sid:=(a->>'session_id')::uuid;
 -- Persistent actor row serializes generation allocation, access capture, and replacement.
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=u FOR UPDATE;
 a:=inbox_bridge.authorize(o);e:=(a->>'access_epoch')::bigint;now_at:=clock_timestamp();
 SELECT max(generation),max(created_at) INTO gen,last_at FROM inbox_bridge.worksets WHERE user_id=u AND session_id=sid;
 IF last_at>now_at-interval '1 second' THEN RAISE EXCEPTION 'INBOX_GENERATION_RATE' USING ERRCODE='55000';END IF;
 IF replaces IS NOT NULL THEN
  SELECT * INTO prior FROM inbox_bridge.worksets WHERE id=replaces FOR UPDATE;
  IF NOT FOUND OR prior.user_id<>u OR prior.session_id<>sid OR prior.org_id<>o OR prior.access_epoch<>e OR prior.revoked THEN RAISE EXCEPTION 'INBOX_REPLACEMENT_DENIED' USING ERRCODE='42501';END IF;
 END IF;
 IF (SELECT count(*) FROM inbox_bridge.worksets WHERE user_id=u AND session_id=sid AND NOT revoked AND expires_at>now_at AND id IS DISTINCT FROM replaces)>=2 THEN RAISE EXCEPTION 'INBOX_GENERATION_LIMIT' USING ERRCODE='55000';END IF;
 view_name:=f->>'view';
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',target_kind,'id',target_id) ORDER BY latest_at DESC NULLS LAST,target_kind,target_id),'[]') INTO ids
 FROM (SELECT target_kind,target_id,latest_at FROM inbox_bridge.summaries WHERE org_id=o AND CASE view_name WHEN 'active' THEN visible_active WHEN 'dismissed' THEN visible_dismissed WHEN 'review' THEN visible_review WHEN 'unread' THEN visible_unread END ORDER BY latest_at DESC NULLS LAST,target_kind,target_id LIMIT n) rows;
 INSERT INTO inbox_bridge.worksets(org_id,user_id,session_id,access_epoch,generation,created_at,expires_at,filter,targets,handles)
 VALUES(o,u,sid,e,coalesce(gen,0)+1,now_at,least(now_at+interval '15 minutes',(a->>'expires_at')::timestamptz),f,ids,(SELECT jsonb_agg(null::text) FROM generate_series(1,greatest(1,(jsonb_array_length(ids)+99)/100)))) RETURNING * INTO created;
 IF replaces IS NOT NULL THEN UPDATE inbox_bridge.worksets SET revoked=true WHERE id=replaces;END IF;
 RETURN inbox_bridge.scope_json(created);
END $$;
CREATE FUNCTION inbox_bridge.get_scope(scope_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w inbox_bridge.worksets;a jsonb;
BEGIN
 SELECT * INTO w FROM inbox_bridge.worksets WHERE id=scope_id;
 IF NOT FOUND OR w.revoked OR w.expires_at<=clock_timestamp() THEN RETURN NULL;END IF;
 a:=inbox_bridge.authorize(w.org_id);
 IF w.user_id<>(a->>'user_id')::uuid OR w.session_id<>(a->>'session_id')::uuid OR w.access_epoch<>(a->>'access_epoch')::bigint THEN RETURN NULL;END IF;
 RETURN inbox_bridge.scope_json(w);
END $$;
CREATE FUNCTION inbox_bridge.bind_handle(scope_id uuid,partition_index integer,expected text,next_handle text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_scope jsonb;
BEGIN
 IF next_handle IS NULL OR length(next_handle)<1 OR length(next_handle)>256 THEN RETURN false;END IF;
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=auth.uid() FOR UPDATE;
 current_scope:=inbox_bridge.get_scope(scope_id);
 IF current_scope IS NULL OR partition_index IS NULL OR partition_index<0 OR partition_index>=jsonb_array_length(current_scope->'handles') THEN RETURN false;END IF;
 UPDATE inbox_bridge.worksets SET handles=jsonb_set(handles,ARRAY[partition_index::text],to_jsonb(next_handle)) WHERE id=scope_id AND (handles->>partition_index) IS NOT DISTINCT FROM expected AND NOT revoked AND expires_at>clock_timestamp();
 RETURN FOUND;
END $$;
ALTER TABLE inbox_bridge.worksets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_bridge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_bridge FROM PUBLIC,anon,authenticated,service_role;


-- Component public_api; pinned fda8ba3148d4da43e821137980dc286789b8041ed93062f4b4d3a583b89429aa
-- Owned fixture only; production application requires reviewed migration installation.


CREATE FUNCTION public.inbox_authorize_sync(org_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_bridge.authorize(org_id) $$;
CREATE FUNCTION public.inbox_create_workset(org_id uuid,filter jsonb,"limit" integer,replaces_scope_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_bridge.create_scope(org_id,filter,"limit",replaces_scope_id) $$;
CREATE FUNCTION public.inbox_get_sync_scope(scope_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_bridge.get_scope(scope_id) $$;
CREATE FUNCTION public.inbox_bind_sync_handle(scope_id uuid,partition_index integer,expected_handle text,next_handle text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_bridge.bind_handle(scope_id,partition_index,expected_handle,next_handle) $$;
REVOKE ALL ON FUNCTION public.inbox_authorize_sync(uuid),public.inbox_create_workset(uuid,jsonb,integer,uuid),public.inbox_get_sync_scope(uuid),public.inbox_bind_sync_handle(uuid,integer,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_authorize_sync(uuid),public.inbox_create_workset(uuid,jsonb,integer,uuid),public.inbox_get_sync_scope(uuid),public.inbox_bind_sync_handle(uuid,integer,text,text) TO authenticated;


-- Component typed_filters; pinned 2525cd7bf1a62c9c2426002e29d2d7b5a5f63a3c1c7c8c5add369006e9de33f3
-- Owned-fixture typed filter implementation; never apply as a production migration.


CREATE TABLE inbox_bridge.filter_rows(
 org_id uuid NOT NULL,target_kind text NOT NULL,target_id uuid NOT NULL,revision bigint NOT NULL,
 latest_at timestamptz,contact_id uuid,has_recent boolean NOT NULL,is_noise boolean NOT NULL,
 assignable boolean NOT NULL,assigned_user_id uuid,unread boolean,escalated boolean NOT NULL,
 needs_outcome boolean NOT NULL,review boolean NOT NULL,unknown_active boolean NOT NULL,unknown_dismissed boolean NOT NULL,
 PRIMARY KEY(org_id,target_kind,target_id)
);
ALTER TABLE inbox_bridge.filter_rows ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION inbox_bridge.upsert_filter(o uuid,k text,id uuid,v bigint,s jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF (s->>'exists')::boolean IS DISTINCT FROM true THEN DELETE FROM inbox_bridge.filter_rows WHERE org_id=o AND target_kind=k AND target_id=id;RETURN;END IF;
 INSERT INTO inbox_bridge.filter_rows VALUES(o,k,id,v,
 (CASE WHEN k='unknown_sender' THEN s->>'latest_at' ELSE s->>'last_message_at' END)::timestamptz,
 (s->>'contact_id')::uuid,coalesce((s->>'has_recent')::boolean,false),coalesce((s->>'is_noise')::boolean,false),
 coalesce(s->>'property_status'<>'prospect',false),(s->>'assigned_user_id')::uuid,
 CASE WHEN k='unknown_sender' THEN NULL ELSE coalesce((s->>'unread_count')::bigint,0)>0 END,
 coalesce(s->>'ai_responder_status'='escalated',false),coalesce((s->>'needs_outcome')::boolean,false),
 s->>'ai_disposition_review_id' IS NOT NULL AND NOT coalesce((s->>'is_test_traffic')::boolean,false),
 coalesce((s->>'visible_unknown')::boolean,false),coalesce((s->>'visible_dismissed')::boolean,false))
 ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET revision=excluded.revision,latest_at=excluded.latest_at,contact_id=excluded.contact_id,
 has_recent=excluded.has_recent,is_noise=excluded.is_noise,assignable=excluded.assignable,assigned_user_id=excluded.assigned_user_id,unread=excluded.unread,
 escalated=excluded.escalated,needs_outcome=excluded.needs_outcome,review=excluded.review,unknown_active=excluded.unknown_active,unknown_dismissed=excluded.unknown_dismissed
 WHERE inbox_bridge.filter_rows.revision<excluded.revision;
END $$;
CREATE FUNCTION inbox_bridge.project_filter() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN PERFORM inbox_bridge.upsert_filter(NEW.org_id,NEW.target_kind,NEW.target_id,NEW.revision,NEW.summary);RETURN NULL;END $$;
CREATE TRIGGER bridge_filter_projection AFTER INSERT OR UPDATE OF summary,revision ON inbox_maintained.rows FOR EACH ROW EXECUTE FUNCTION inbox_bridge.project_filter();
CREATE INDEX filter_all ON inbox_bridge.filter_rows(org_id,latest_at DESC NULLS LAST,target_kind,target_id);
CREATE INDEX filter_known_visible ON inbox_bridge.filter_rows(org_id,latest_at DESC NULLS LAST,target_kind,target_id) WHERE target_kind='known_conversation' AND has_recent AND NOT is_noise;
CREATE INDEX filter_mine ON inbox_bridge.filter_rows(org_id,assigned_user_id,latest_at DESC NULLS LAST,target_kind,target_id) WHERE target_kind='known_conversation' AND has_recent AND NOT is_noise AND assignable;
CREATE INDEX filter_unread ON inbox_bridge.filter_rows(org_id,latest_at DESC NULLS LAST,target_kind,target_id) WHERE target_kind='known_conversation' AND has_recent AND NOT is_noise AND unread;
CREATE INDEX filter_escalated ON inbox_bridge.filter_rows(org_id,latest_at DESC NULLS LAST,target_kind,target_id) WHERE target_kind='known_conversation' AND has_recent AND NOT is_noise AND escalated;
CREATE INDEX filter_unknown ON inbox_bridge.filter_rows(org_id,latest_at DESC NULLS LAST,target_kind,target_id) WHERE target_kind='unknown_sender' AND unknown_active;
CREATE FUNCTION inbox_bridge.page(o uuid,u uuid,f jsonb,cursor_at timestamptz,cursor_kind text,cursor_id uuid,has_cursor boolean,n integer)
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
CREATE FUNCTION inbox_bridge.counts_typed(o uuid,u uuid,f jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH scoped AS (
 SELECT r.*,r.target_kind='known_conversation' AS known,r.has_recent AND (NOT (f->>'hide_noise')::boolean OR NOT r.is_noise) AS visible
 FROM inbox_bridge.filter_rows r WHERE r.org_id=o
 AND (f->>'search' IS NULL OR r.target_kind='unknown_sender'
 OR EXISTS(SELECT 1 FROM public.contacts ct WHERE ct.org_id=o AND ct.id=r.contact_id AND
  (ct.search_text ILIKE '%'||replace(replace(replace(lower(f->>'search'),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%' ESCAPE E'\\'
  OR (length(regexp_replace(f->>'search','[^0-9]','','g'))>=3 AND ct.phone_digits ILIKE '%'||regexp_replace(f->>'search','[^0-9]','','g')||'%')))
 OR EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=o AND m.conversation_id=r.target_id AND m.channel='sms' AND m.fts @@ public.search_prefix_tsquery(f->>'search')))
 ) SELECT jsonb_build_object(
 'all',count(*) FILTER(WHERE known AND visible),
 'mine',count(*) FILTER(WHERE known AND visible AND assignable AND assigned_user_id=u),
 'unassigned',count(*) FILTER(WHERE known AND visible AND assignable AND assigned_user_id IS NULL),
 'unread',count(*) FILTER(WHERE known AND visible AND unread),
 'escalated',count(*) FILTER(WHERE known AND visible AND escalated),
 'dispo',count(*) FILTER(WHERE known AND review),
 'needs_outcome',count(*) FILTER(WHERE known AND visible AND needs_outcome),
 'unknown',count(*) FILTER(WHERE NOT known AND unknown_active),
 'dismissed',count(*) FILTER(WHERE NOT known AND unknown_dismissed)) FROM scoped;
$$;
REVOKE ALL ON FUNCTION inbox_bridge.counts_typed(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON TABLE inbox_bridge.filter_rows FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION inbox_bridge.upsert_filter(uuid,text,uuid,bigint,jsonb),inbox_bridge.project_filter(),inbox_bridge.page(uuid,uuid,jsonb,timestamptz,text,uuid,boolean,integer) FROM PUBLIC,anon,authenticated,service_role;


-- Component parity; pinned c0af18a7c18171b5847dc53820c0e2494069ea5d4705247ee596749a2bfb2399
-- Owned-fixture source candidate. Not installed until exclusive T2 test grant.


CREATE TABLE inbox_bridge.cursors(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),scope_id uuid NOT NULL REFERENCES inbox_bridge.worksets(id),
 latest_at timestamptz,target_kind text NOT NULL,target_id uuid NOT NULL
);
ALTER TABLE inbox_bridge.cursors ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION inbox_bridge.normalize_filter(f jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE q text;
BEGIN
 IF f IS NULL OR jsonb_typeof(f)<>'object' OR (f-ARRAY['view','hide_noise','search'])<>'{}'::jsonb
 OR jsonb_typeof(f->'view') IS DISTINCT FROM 'string' OR f->>'view' NOT IN ('active','all','mine','unassigned','unread','escalated','dispo','needs_outcome','unknown','dismissed')
 OR (f?'hide_noise' AND jsonb_typeof(f->'hide_noise') IS DISTINCT FROM 'boolean')
 OR (f?'search' AND jsonb_typeof(f->'search') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'INBOX_FILTER_INVALID' USING ERRCODE='22023';END IF;
 q:=left(btrim(coalesce(f->>'search','')),100);IF length(q)<3 THEN q:=NULL;END IF;
 RETURN jsonb_build_object('view',f->>'view','hide_noise',coalesce((f->>'hide_noise')::boolean,true),'search',q);
END $$;
CREATE FUNCTION inbox_bridge.matching(o uuid,u uuid,f jsonb)
RETURNS TABLE(target_kind text,target_id uuid,latest_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH p AS (SELECT f->>'view' AS view, (f->>'hide_noise')::boolean AS hide_noise,f->>'search' AS q),
 candidates AS (
 SELECT r.target_kind,r.target_id,r.summary s,CASE WHEN r.target_kind='unknown_sender' THEN (r.summary->>'latest_at')::timestamptz ELSE (r.summary->>'last_message_at')::timestamptz END latest_at
 FROM inbox_maintained.rows r WHERE r.org_id=o AND (r.summary->>'exists')::boolean
 )
 SELECT c.target_kind,c.target_id,c.latest_at FROM candidates c CROSS JOIN p
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
 END;
$$;
CREATE FUNCTION public.inbox_counts_v2(org_id uuid,filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;after_access jsonb;f jsonb;result jsonb;
BEGIN
 a:=inbox_bridge.authorize(org_id);f:=inbox_bridge.normalize_filter(filter);
 SELECT inbox_bridge.counts_typed(org_id,(a->>'user_id')::uuid,f) INTO result;
 after_access:=inbox_bridge.authorize(org_id);
 IF (after_access->>'user_id',after_access->>'session_id',after_access->>'access_epoch') IS DISTINCT FROM (a->>'user_id',a->>'session_id',a->>'access_epoch') THEN RAISE EXCEPTION 'INBOX_ACCESS_CHANGED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('counts',result,'as_of',statement_timestamp(),'access_epoch',a->>'access_epoch');
END $$;
CREATE TYPE inbox_bridge.cursor_context AS (id uuid,org_id uuid,user_id uuid,session_id uuid,access_epoch bigint,generation bigint,created_at timestamptz,expires_at timestamptz,filter jsonb,targets jsonb,handles jsonb,revoked boolean,cursor_at timestamptz,cursor_kind text,cursor_target uuid);
CREATE FUNCTION public.inbox_create_workset_v2(org_id uuid,filter jsonb,"limit" integer,replaces_scope_id uuid DEFAULT NULL,cursor_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;u uuid;sid uuid;e bigint;now_at timestamptz;prior inbox_bridge.worksets;created inbox_bridge.worksets;ids jsonb;gen bigint;last_at timestamptz;view_name text;o uuid:=org_id;f jsonb; n integer:="limit";replaces uuid:=replaces_scope_id;cur inbox_bridge.cursor_context;page_rows jsonb;last_row jsonb;next_id uuid;
BEGIN
 f:=inbox_bridge.normalize_filter(filter);
 IF n IS NULL OR n<1 OR n>500 THEN RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';END IF;
 a:=inbox_bridge.authorize(o);u:=(a->>'user_id')::uuid;sid:=(a->>'session_id')::uuid;
 -- Persistent actor row serializes generation allocation, access capture, and replacement.
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=u FOR UPDATE;
 a:=inbox_bridge.authorize(o);e:=(a->>'access_epoch')::bigint;now_at:=clock_timestamp();
 SELECT max(generation),max(created_at) INTO gen,last_at FROM inbox_bridge.worksets WHERE user_id=u AND session_id=sid;
 IF last_at>now_at-interval '1 second' THEN RAISE EXCEPTION 'INBOX_GENERATION_RATE' USING ERRCODE='55000';END IF;
 IF replaces IS NOT NULL THEN
  SELECT * INTO prior FROM inbox_bridge.worksets WHERE id=replaces FOR UPDATE;
  IF NOT FOUND OR prior.user_id<>u OR prior.session_id<>sid OR prior.org_id<>o OR prior.access_epoch<>e OR prior.revoked THEN RAISE EXCEPTION 'INBOX_REPLACEMENT_DENIED' USING ERRCODE='42501';END IF;
 END IF;
 IF (SELECT count(*) FROM inbox_bridge.worksets WHERE user_id=u AND session_id=sid AND NOT revoked AND expires_at>now_at AND id IS DISTINCT FROM replaces)>=2 THEN RAISE EXCEPTION 'INBOX_GENERATION_LIMIT' USING ERRCODE='55000';END IF;
 IF cursor_id IS NOT NULL THEN
  SELECT w.id,w.org_id,w.user_id,w.session_id,w.access_epoch,w.generation,w.created_at,w.expires_at,w.filter,w.targets,w.handles,w.revoked,c.latest_at AS cursor_at,c.target_kind AS cursor_kind,c.target_id AS cursor_target INTO cur
  FROM inbox_bridge.cursors c JOIN inbox_bridge.worksets w ON w.id=c.scope_id WHERE c.id=cursor_id;
  IF NOT FOUND OR cur.user_id<>u OR cur.session_id<>sid OR cur.org_id<>o OR cur.access_epoch<>e OR cur.expires_at<=now_at OR cur.revoked OR cur.filter IS DISTINCT FROM f THEN RAISE EXCEPTION 'INBOX_CURSOR_DENIED' USING ERRCODE='42501';END IF;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY latest_at DESC NULLS LAST,target_kind,target_id),'[]') INTO page_rows FROM (
 SELECT * FROM inbox_bridge.page(o,u,f,cur.cursor_at,cur.cursor_kind,cur.cursor_target,cursor_id IS NOT NULL,n+1)
) rows;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',x->>'target_kind','id',x->>'target_id') ORDER BY ordinal),'[]') INTO ids FROM jsonb_array_elements(page_rows) WITH ORDINALITY a(x,ordinal) WHERE ordinal<=n;
 INSERT INTO inbox_bridge.worksets(org_id,user_id,session_id,access_epoch,generation,created_at,expires_at,filter,targets,handles)
 VALUES(o,u,sid,e,coalesce(gen,0)+1,now_at,least(now_at+interval '15 minutes',(a->>'expires_at')::timestamptz),f,ids,(SELECT jsonb_agg(null::text) FROM generate_series(1,greatest(1,(jsonb_array_length(ids)+99)/100)))) RETURNING * INTO created;
 IF replaces IS NOT NULL THEN UPDATE inbox_bridge.worksets SET revoked=true WHERE id=replaces;END IF;
 IF jsonb_array_length(page_rows)>n THEN
  last_row:=page_rows->(n-1);
  INSERT INTO inbox_bridge.cursors(scope_id,latest_at,target_kind,target_id) VALUES(created.id,(last_row->>'latest_at')::timestamptz,last_row->>'target_kind',(last_row->>'target_id')::uuid) RETURNING id INTO next_id;
 END IF;
 RETURN inbox_bridge.scope_json(created)||jsonb_build_object('next_cursor',next_id,'refreshed',cursor_id IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION public.inbox_create_workset_v2(uuid,jsonb,integer,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_create_workset_v2(uuid,jsonb,integer,uuid,uuid) TO authenticated;
REVOKE ALL ON TABLE inbox_bridge.cursors FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION inbox_bridge.normalize_filter(jsonb),inbox_bridge.matching(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_counts_v2(uuid,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_counts_v2(uuid,jsonb) TO authenticated;


-- Component outcomes; pinned fc365e47abf71613744e9f9aa8b8cb7c937cdf2042e655d689d83f0ce793a299
-- Disposable fixture candidate; requires reviewed performance dependency. No production migration.


ALTER TABLE inbox_bridge.filter_rows ADD COLUMN outreach_dispo text;
CREATE OR REPLACE FUNCTION inbox_bridge.upsert_filter(o uuid,k text,id uuid,v bigint,s jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF (s->>'exists')::boolean IS DISTINCT FROM true THEN DELETE FROM inbox_bridge.filter_rows WHERE org_id=o AND target_kind=k AND target_id=id;RETURN;END IF;
 INSERT INTO inbox_bridge.filter_rows VALUES(o,k,id,v,
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
 WHERE inbox_bridge.filter_rows.revision<excluded.revision;
END $$;

CREATE FUNCTION inbox_bridge.outcome_counts(o uuid,u uuid,f jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH scoped AS (
 SELECT r.outreach_dispo,r.target_kind,r.has_recent,r.is_noise,r.unknown_active
 FROM inbox_bridge.filter_rows r WHERE r.org_id=o
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
 a:=inbox_bridge.authorize(org_id);f:=inbox_bridge.normalize_filter(filter);
 SELECT inbox_bridge.outcome_counts(org_id,(a->>'user_id')::uuid,f) INTO result;
 after_access:=inbox_bridge.authorize(org_id);
 IF (after_access->>'user_id',after_access->>'session_id',after_access->>'access_epoch') IS DISTINCT FROM (a->>'user_id',a->>'session_id',a->>'access_epoch') THEN RAISE EXCEPTION 'INBOX_ACCESS_CHANGED' USING ERRCODE='42501';END IF;
 RETURN result||jsonb_build_object('as_of',statement_timestamp(),'access_epoch',a->>'access_epoch','semantics',jsonb_build_object('known','recent_known_conversations','hide_noise',(f->>'hide_noise')::boolean,'search',f->'search','unknown','active_unknown_ignores_known_search','unit','conversation','view','all'));
END $$;
REVOKE ALL ON FUNCTION inbox_bridge.outcome_counts(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_outcome_counts_v1(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_outcome_counts_v1(uuid,jsonb) TO authenticated;

-- Candidate operational primitives. No API activation or scheduling side effect.
CREATE TABLE inbox_control.baseline_progress(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),stage text NOT NULL DEFAULT 'memberships' CHECK(stage IN ('memberships','organizations','done')),cursor uuid);
INSERT INTO inbox_control.baseline_progress(singleton) VALUES(true);
ALTER TABLE inbox_control.baseline_progress ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION inbox_control.seed_baseline_batch(p_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE state inbox_control.baseline_progress%ROWTYPE;ids uuid[];u uuid;o uuid;n integer;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN RAISE EXCEPTION 'Invalid baseline batch limit';END IF;
 SELECT * INTO STRICT state FROM inbox_control.baseline_progress WHERE singleton FOR UPDATE;
 IF state.stage='done' THEN RETURN jsonb_build_object('stage','done','rows',0);END IF;
 IF state.stage='memberships' THEN
  SELECT array_agg(user_id ORDER BY user_id) INTO ids FROM(SELECT DISTINCT user_id FROM public.memberships WHERE state.cursor IS NULL OR user_id>state.cursor ORDER BY user_id LIMIT p_limit)s;
  FOREACH u IN ARRAY coalesce(ids,'{}'::uuid[]) LOOP
   INSERT INTO inbox_bridge.access_epochs(user_id,revision) VALUES(u,1) ON CONFLICT DO NOTHING;
  END LOOP;
 ELSE
  SELECT array_agg(id ORDER BY id) INTO ids FROM(SELECT id FROM public.organizations WHERE state.cursor IS NULL OR id>state.cursor ORDER BY id LIMIT p_limit)s;
  FOREACH o IN ARRAY coalesce(ids,'{}'::uuid[]) LOOP
   IF NOT EXISTS(SELECT 1 FROM inbox_backfill.jobs WHERE org_id=o) THEN PERFORM inbox_backfill.start(o);END IF;
  END LOOP;
 END IF;
 n:=coalesce(cardinality(ids),0);
 UPDATE inbox_control.baseline_progress SET stage=CASE WHEN n=p_limit THEN state.stage WHEN state.stage='memberships' THEN 'organizations' ELSE 'done' END,cursor=CASE WHEN n=p_limit THEN ids[n] END WHERE singleton;
 RETURN jsonb_build_object('stage',state.stage,'rows',n);
END $$;
CREATE FUNCTION inbox_control.wake_due_expiries(p_limit integer DEFAULT 100) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r record;n integer:=0;at_time timestamptz:=clock_timestamp();
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid expiry limit';END IF;
 FOR r IN SELECT org_id,target_kind,target_id,revision FROM inbox_maintained.rows WHERE next_expiry<=at_time ORDER BY next_expiry,org_id,target_kind,target_id LIMIT p_limit LOOP
  PERFORM inbox_maintained.wake_expiry(r.org_id,r.target_kind,r.target_id,r.revision,at_time);n:=n+1;
 END LOOP;
 RETURN n;
END $$;
CREATE FUNCTION inbox_control.readiness() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('serving_enabled',(SELECT serving_enabled FROM inbox_control.rollout WHERE singleton),
 'baseline_done',(SELECT stage='done' FROM inbox_control.baseline_progress WHERE singleton),
 'backfill_pending',EXISTS(SELECT 1 FROM inbox_backfill.jobs WHERE stream<>'done'),
 'queue_pending',EXISTS(SELECT 1 FROM inbox_maintained.queue),
 'parent_pending',EXISTS(SELECT 1 FROM inbox_parent.work WHERE generation>ack),
 'collisions_unresolved',EXISTS(SELECT 1 FROM inbox_backfill.collisions WHERE generation>ack OR duplicate_thread_ids IS NOT NULL),
 'due_expiry',EXISTS(SELECT 1 FROM inbox_maintained.rows WHERE next_expiry<=statement_timestamp()));
$$;
-- Runtime grants must name a separately reviewed worker role. Browser/service roles cannot drive these helpers.
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_control FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_control FROM PUBLIC,anon,authenticated,service_role;
-- Operations and read owners confirm no runtime/FK dependency on expired worksets.
-- Never apply this policy to operation, read-boundary, provider or safety receipts.
CREATE INDEX inbox_workset_expiry ON inbox_bridge.worksets(expires_at,id);
CREATE INDEX inbox_cursor_scope ON inbox_bridge.cursors(scope_id);
CREATE FUNCTION inbox_control.prune_expired_worksets(p_limit integer DEFAULT 100,p_retention_seconds integer DEFAULT 604800) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r record;n integer:=0;cutoff timestamptz;cursor_budget integer:=1000;removed integer;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 OR p_retention_seconds IS NULL OR p_retention_seconds<86400 OR p_retention_seconds>2592000 THEN RAISE EXCEPTION 'Invalid retention bounds';END IF;
 cutoff:=clock_timestamp()-make_interval(secs=>p_retention_seconds);
 FOR r IN SELECT id FROM inbox_bridge.worksets WHERE expires_at<cutoff ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  -- Bound physical deletion work as well as selected worksets. The worker caller
  -- must also set a statement timeout; SQL-local timeout changes do not restart
  -- the current statement timer. A cursor-heavy scope resumes on the next call.
  WITH candidates AS (SELECT id FROM inbox_bridge.cursors WHERE scope_id=r.id LIMIT cursor_budget)
  DELETE FROM inbox_bridge.cursors c USING candidates d WHERE c.id=d.id;
  GET DIAGNOSTICS removed=ROW_COUNT;cursor_budget:=cursor_budget-removed;
  IF NOT EXISTS(SELECT 1 FROM inbox_bridge.cursors WHERE scope_id=r.id) THEN
   DELETE FROM inbox_bridge.worksets WHERE id=r.id;n:=n+1;
  END IF;
  IF cursor_budget=0 THEN EXIT;END IF;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION inbox_control.prune_expired_worksets(integer,integer) FROM PUBLIC,anon,authenticated,service_role;
-- Production candidate has only explicitly reviewed public API entry points.
-- SECURITY DEFINER internal calls retain owner access; dedicated worker grants are separate.
DO $$ DECLARE n text; BEGIN
 -- Exact reviewed bundle inventory; never touch unrelated Inbox schemas.
 FOREACH n IN ARRAY ARRAY['inbox_control','inbox_summary_contract','inbox_unknown_summary','inbox_authenticated_detail','inbox_capture_boundary','inbox_message_capture','inbox_maintained','inbox_parent','inbox_safety','inbox_backfill','inbox_policy','inbox_bridge','inbox_read'] LOOP
  IF to_regnamespace(n) IS NULL THEN CONTINUE;END IF;
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC,anon,authenticated,service_role',n);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC,anon,authenticated,service_role',n);
 END LOOP;
END $$;

-- Narrow DTO only. Do not publish maintained JSON, worksets, auth or policy tables.
ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY FULL;
-- Capture remains installed; serving is disabled until independent activation gates.
COMMIT;
