-- Worker-private, source-faithful compute candidate. Offline rehearsal only.
-- Canonical source: supabase/migrations/20260909080000_messages_search.sql.
-- No user authorization, search, aggregation across conversations, or production migration.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
 OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic')
 THEN RAISE EXCEPTION 'Owned isolated fixture required'; END IF;
END $$;
CREATE SCHEMA inbox_t2_summary_contract AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_summary_contract FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_t2_summary_contract.compute(p_org_id uuid,p_conversation_id uuid,p_as_of timestamptz)
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
REVOKE ALL ON FUNCTION inbox_t2_summary_contract.compute(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
