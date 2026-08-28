-- PR #417 widened the 90-day inbox workset before grouping and made every
-- authenticated Messages filter exceed production's statement timeout.
--
-- Preserve the Sandra Dispo semantics, including pending reviews whose latest
-- message is older than the inbox cutoff, while keeping the proven recent
-- inbox path narrow. Only the tiny pending-review workset reads full
-- conversation history for review conversations that have no recent messages;
-- the two grouped result sets are combined afterwards. A recent pending-review
-- conversation remains on the ordinary 90-day inbox path. Recomputing its old
-- unread history was explicitly outside the Sandra Dispo release contract and
-- makes latency grow with the review backlog.
create or replace function public.sms_inbox_thread_page_snapshot(
  p_cutoff timestamptz,
  p_filter text default 'all',
  p_assignee_id uuid default null,
  p_include_thread_id uuid default null,
  p_hide_noise boolean default true,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    select
      greatest(
        coalesce(p_cutoff, statement_timestamp() - interval '365 days'),
        statement_timestamp() - interval '365 days'
      ) as cutoff,
      least(greatest(coalesce(p_limit, 200), 1), 500) as page_limit,
      greatest(coalesce(p_offset, 0), 0) as requested_offset,
      case
        when p_filter in ('all', 'mine', 'unassigned', 'unread', 'escalated', 'dispo', 'needs_outcome')
          then p_filter
        else 'all'
      end as active_filter
  ),
  visible_orgs as materialized (
    select membership.org_id
    from public.memberships membership
    where current_user = 'authenticated'
      and membership.user_id = auth.uid()
      and membership.access_status = 'active'
      and membership.deletion_prepared_at is null
      and (
        membership.access_expires_at is null
        or membership.access_expires_at > statement_timestamp()
      )
  ),
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
      and (
        current_user <> 'authenticated'
        or review.org_id in (select visible.org_id from visible_orgs visible)
      )
  ),
  recent_eligible as materialized (
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
      and (
        current_user <> 'authenticated'
        or m.org_id in (select visible.org_id from visible_orgs visible)
      )
  ),
  recent_grouped as materialized (
    select
      e.org_id,
      e.conversation_id,
      (array_agg(e.id order by e.created_at desc, e.id desc))[1] as last_message_id,
      (array_agg(e.contact_id order by e.created_at desc, e.id desc))[1] as contact_id,
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
  conversation_ambiguities as (
    select case
      when current_user = 'authenticated'
        and (select count(*) from visible_orgs) <= 1
      then 0
      else (
        select count(*)::integer
        from (
          select m.conversation_id
          from public.messages m
          where m.channel = 'sms'
            and m.conversation_id in (
              select grouped_thread.conversation_id from grouped grouped_thread
            )
            and (
              current_user <> 'authenticated'
              or m.org_id in (select visible.org_id from visible_orgs visible)
            )
          group by m.conversation_id
          having count(distinct m.org_id) > 1
        ) collisions
      )
    end as ambiguity_count
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
  counts as (
    select
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise))::integer as all_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and p_assignee_id is not null and c.assigned_user_id = p_assignee_id)::integer as mine_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and p_assignee_id is not null and c.assigned_user_id is null)::integer as unassigned_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.unread_count > 0)::integer as unread_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.ai_responder_status = 'escalated')::integer as escalated_count,
      count(*) filter (where c.ai_disposition_review_id is not null and not c.is_test_traffic)::integer as dispo_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.needs_outcome)::integer as needs_outcome_count
    from classified c
  ),
  active_unhidden as materialized (
    select c.*
    from classified c
    cross join bounds b
    where case b.active_filter
      when 'mine' then c.has_recent and p_assignee_id is not null and c.assigned_user_id = p_assignee_id
      when 'unassigned' then c.has_recent and p_assignee_id is not null and c.assigned_user_id is null
      when 'unread' then c.has_recent and (c.unread_count > 0 or c.conversation_id = p_include_thread_id)
      when 'escalated' then c.has_recent and c.ai_responder_status = 'escalated'
      when 'dispo' then c.ai_disposition_review_id is not null
      when 'needs_outcome' then c.has_recent and c.needs_outcome
      else c.has_recent
    end
  ),
  active_filtered as materialized (
    select active.*
    from active_unhidden active
    cross join bounds b
    where case b.active_filter
      -- Compliance outcomes are still actionable review work. Test fixtures
      -- never are, even when the caller asks to show ordinary hidden noise.
      when 'dispo' then not active.is_test_traffic
      else not p_hide_noise or not active.is_noise
    end
  ),
  page_meta as (
    select
      count(*)::integer as total_count,
      coalesce((select count(*) from active_unhidden), 0)::integer
        - count(*)::integer as hidden_count
    from active_filtered
  ),
  effective_page as (
    select
      b.page_limit,
      case
        when meta.total_count = 0 then 0
        else least(
          b.requested_offset,
          ((meta.total_count - 1) / b.page_limit) * b.page_limit
        )
      end as page_offset
    from bounds b cross join page_meta meta
  ),
  page_core as materialized (
    select active.*
    from active_filtered active
    order by active.last_message_at desc, active.conversation_id
    limit (select page_limit from effective_page)
    offset (select page_offset from effective_page)
  ),
  page_rows as (
    select
      page.*,
      last_message.body as last_message_body,
      thread.ai_responder_reason,
      thread.ai_responder_status_at,
      thread.ai_last_delivery_status,
      thread.ai_last_delivery_error
    from page_core page
    join public.messages last_message
      on last_message.id = page.last_message_id
      and last_message.org_id = page.org_id
      and last_message.conversation_id = page.conversation_id
    left join public.message_threads thread
      on thread.conversation_id = page.conversation_id
      and thread.org_id = page.org_id
  ),
  document as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'thread_id', row.conversation_id,
        'contact_id', row.contact_id,
        'contact_name', row.contact_name,
        'thread_customer_phone', row.thread_customer_phone,
        'thread_business_phone', row.thread_business_phone,
        'property_id', row.property_id,
        'property_address', row.property_address,
        'property_status', row.property_status,
        'outreach_dispo', row.outreach_dispo,
        'is_dnc_locked', coalesce(row.is_dnc_locked, false),
        'assignee_id', row.assigned_user_id,
        'last_message_body', row.last_message_body,
        'last_message_direction', row.last_message_direction,
        'last_message_at', row.last_message_at,
        'unread_count', row.unread_count,
        'has_inbound', row.has_inbound,
        'needs_human_attention', coalesce(row.needs_human_attention, false),
        'escalation_reason', case when row.needs_human_attention then row.last_ai_escalation_reason else null end,
        'is_opted_out', row.is_opted_out,
        'is_test_traffic', row.is_test_traffic,
        'needs_outcome', row.needs_outcome,
        'ai_responder_status', row.ai_responder_status,
        'ai_responder_reason', row.ai_responder_reason,
        'ai_responder_status_at', row.ai_responder_status_at,
        'ai_last_delivery_status', row.ai_last_delivery_status,
        'ai_last_delivery_error', row.ai_last_delivery_error,
        'ai_disposition_review_id', row.ai_disposition_review_id,
        'ai_disposition_review_status', row.ai_disposition_review_status,
        'ai_disposition_review_disposition', row.ai_disposition_review_disposition,
        'ai_disposition_review_reason', row.ai_disposition_review_reason,
        'ai_disposition_review_created_at', row.ai_disposition_review_created_at,
        'ai_disposition_review_source_inbound_message_id', row.ai_disposition_review_source_inbound_message_id
      ) order by row.last_message_at desc, row.conversation_id
    ), '[]'::jsonb) as rows
    from page_rows row
  )
  select case
    when ambiguities.ambiguity_count > 0 then jsonb_build_object(
      '__error', 'cross_org_conversation_id_ambiguity',
      'count', ambiguities.ambiguity_count
    )
    else jsonb_build_object(
      'rows', document.rows,
      'counts', jsonb_build_object(
        'all', counts.all_count,
        'mine', counts.mine_count,
        'unassigned', counts.unassigned_count,
        'unread', counts.unread_count,
        'escalated', counts.escalated_count,
        'dispo', counts.dispo_count,
        'needs_outcome', counts.needs_outcome_count
      ),
      'total', meta.total_count,
      'hidden_count', meta.hidden_count,
      'limit', page.page_limit,
      'offset', page.page_offset
    )
  end
  from conversation_ambiguities ambiguities
  cross join counts
  cross join page_meta meta
  cross join effective_page page
  cross join document;
$$;

revoke all on function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer) from public;
revoke all on function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer) from anon;
grant execute on function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer) to authenticated;
grant execute on function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer) to service_role;

comment on function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer) is
  'RLS-scoped SMS inbox: recent-thread filters plus a cutoff-independent pending AI disposition review queue.';
