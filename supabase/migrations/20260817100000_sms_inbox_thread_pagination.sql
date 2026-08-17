-- Production inboxes can contain tens of thousands of active SMS conversations.
-- Keep counts authoritative over the complete window, but return only one
-- server-filtered page of hydrated rows to the application.
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
  eligible as (
    select
      m.*,
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
        or exists (
          select 1
          from public.memberships membership
          where membership.user_id = auth.uid()
            and membership.org_id = m.org_id
            and membership.access_status = 'active'
            and membership.deletion_prepared_at is null
            and (
              membership.access_expires_at is null
              or membership.access_expires_at > statement_timestamp()
            )
        )
      )
  ),
  grouped as (
    select
      e.org_id,
      e.conversation_id,
      (array_agg(e.contact_id order by e.created_at desc, e.id desc))[1] as contact_id,
      (array_agg(e.property_id order by e.created_at desc, e.id desc)
        filter (where e.property_id is not null))[1] as property_id,
      count(*) filter (
        where e.direction = 'inbound' and e.read_at is null
      )::integer as unread_count,
      bool_or(e.direction = 'inbound') as has_inbound,
      max(e.body) filter (where e.latest_rank = 1) as last_message_body,
      max(e.direction) filter (where e.latest_rank = 1) as last_message_direction,
      max(e.created_at) filter (where e.latest_rank = 1) as last_message_at,
      max(e.from_address) filter (where e.latest_rank = 1) as latest_from,
      max(e.to_address) filter (where e.latest_rank = 1) as latest_to
    from eligible e
    group by e.org_id, e.conversation_id
  ),
  conversation_ambiguities as (
    select count(*)::integer as ambiguity_count
    from (
      select m.conversation_id
      from public.messages m
      where m.channel = 'sms'
        and m.conversation_id in (
          select grouped_thread.conversation_id from grouped grouped_thread
        )
        and (
          current_user <> 'authenticated'
          or exists (
            select 1
            from public.memberships membership
            where membership.user_id = auth.uid()
              and membership.org_id = m.org_id
              and membership.access_status = 'active'
              and membership.deletion_prepared_at is null
              and (
                membership.access_expires_at is null
                or membership.access_expires_at > statement_timestamp()
              )
          )
        )
      group by m.conversation_id
      having count(distinct m.org_id) > 1
    ) collisions
  ),
  hydrated as materialized (
    select
      g.*,
      coalesce(c.entity_name, nullif(concat_ws(' ', c.first_name, c.last_name), '')) as contact_name,
      c.do_not_contact,
      c.sms_opted_out,
      p.address,
      p.city,
      p.state,
      p.status as property_status,
      p.outreach_dispo,
      p.is_dnc_locked,
      p.assigned_user_id,
      p.needs_human_attention,
      p.last_ai_escalation_reason,
      mt.ai_responder_status,
      mt.ai_responder_reason,
      mt.ai_responder_status_at,
      mt.ai_last_delivery_status,
      mt.ai_last_delivery_error,
      ce.event_type as latest_consent_event,
      coalesce(durable_suppression.is_phone_suppressed, false) as is_phone_suppressed
    from grouped g
    left join public.contacts c on c.id = g.contact_id and c.org_id = g.org_id
    left join public.properties p on p.id = g.property_id and p.org_id = g.org_id
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
      select true as is_phone_suppressed
      from public.sms_phone_suppressions suppression
      where suppression.org_id = g.org_id
        and suppression.channel = 'sms'
        and suppression.phone_e164 = case
          when length(regexp_replace(coalesce(case when g.last_message_direction = 'inbound' then g.latest_from else g.latest_to end, ''), '[^0-9]', '', 'g')) = 11
            and left(regexp_replace(coalesce(case when g.last_message_direction = 'inbound' then g.latest_from else g.latest_to end, ''), '[^0-9]', '', 'g'), 1) = '1'
            then '+' || regexp_replace(coalesce(case when g.last_message_direction = 'inbound' then g.latest_from else g.latest_to end, ''), '[^0-9]', '', 'g')
          when length(regexp_replace(coalesce(case when g.last_message_direction = 'inbound' then g.latest_from else g.latest_to end, ''), '[^0-9]', '', 'g')) = 10
            then '+1' || regexp_replace(coalesce(case when g.last_message_direction = 'inbound' then g.latest_from else g.latest_to end, ''), '[^0-9]', '', 'g')
          else null
        end
      limit 1
    ) durable_suppression on true
  ),
  classified as materialized (
    select
      h.*,
      case when h.last_message_direction = 'inbound' then h.latest_from else h.latest_to end as thread_customer_phone,
      case when h.last_message_direction = 'inbound' then h.latest_to else h.latest_from end as thread_business_phone,
      nullif(concat_ws(', ', h.address, h.city, h.state), '') as property_address,
      coalesce(h.do_not_contact, false)
        or coalesce(h.sms_opted_out, false)
        or h.is_phone_suppressed
        or coalesce(h.latest_consent_event in ('opt_out', 'provider_auto_opt_out'), false) as is_opted_out,
      lower(trim(coalesce(h.contact_name, ''))) like 'canary canary-%%'
        or lower(trim(coalesce(nullif(concat_ws(', ', h.address, h.city, h.state), ''), ''))) like 'jitter %%'
        or lower(trim(coalesce(nullif(concat_ws(', ', h.address, h.city, h.state), ''), ''))) like 'jitter-%%' as is_test_traffic
    from hydrated h
  ),
  ready as materialized (
    select
      c.*,
      c.property_id is not null
        and c.has_inbound
        and c.outreach_dispo is null
        and not c.is_opted_out
        and c.property_status in ('prospect', 'new_lead', 'contacted') as needs_outcome,
      coalesce(c.is_dnc_locked, false) or c.is_opted_out or c.is_test_traffic as is_noise
    from classified c
  ),
  counts as (
    select
      count(*) filter (where not p_hide_noise or not r.is_noise)::integer as all_count,
      count(*) filter (where (not p_hide_noise or not r.is_noise) and p_assignee_id is not null and r.assigned_user_id = p_assignee_id)::integer as mine_count,
      count(*) filter (where (not p_hide_noise or not r.is_noise) and p_assignee_id is not null and r.assigned_user_id is null)::integer as unassigned_count,
      count(*) filter (where (not p_hide_noise or not r.is_noise) and r.unread_count > 0)::integer as unread_count,
      count(*) filter (where (not p_hide_noise or not r.is_noise) and r.ai_responder_status = 'escalated')::integer as escalated_count,
      count(*) filter (where (not p_hide_noise or not r.is_noise) and r.outreach_dispo is not null)::integer as dispo_count,
      count(*) filter (where (not p_hide_noise or not r.is_noise) and r.needs_outcome)::integer as needs_outcome_count
    from ready r
  ),
  active_unhidden as materialized (
    select r.*
    from ready r
    cross join bounds b
    where case b.active_filter
      when 'mine' then p_assignee_id is not null and r.assigned_user_id = p_assignee_id
      when 'unassigned' then p_assignee_id is not null and r.assigned_user_id is null
      when 'unread' then r.unread_count > 0 or r.conversation_id = p_include_thread_id
      when 'escalated' then r.ai_responder_status = 'escalated'
      when 'dispo' then r.outreach_dispo is not null
      when 'needs_outcome' then r.needs_outcome
      else true
    end
  ),
  active_filtered as materialized (
    select a.* from active_unhidden a where not p_hide_noise or not a.is_noise
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
  page_rows as (
    select r.*
    from active_filtered r
    order by r.last_message_at desc, r.conversation_id
    limit (select page_limit from effective_page)
    offset (select page_offset from effective_page)
  ),
  document as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'thread_id', r.conversation_id,
        'contact_id', r.contact_id,
        'contact_name', r.contact_name,
        'thread_customer_phone', r.thread_customer_phone,
        'thread_business_phone', r.thread_business_phone,
        'property_id', r.property_id,
        'property_address', r.property_address,
        'property_status', r.property_status,
        'outreach_dispo', r.outreach_dispo,
        'is_dnc_locked', coalesce(r.is_dnc_locked, false),
        'assignee_id', r.assigned_user_id,
        'last_message_body', r.last_message_body,
        'last_message_direction', r.last_message_direction,
        'last_message_at', r.last_message_at,
        'unread_count', r.unread_count,
        'has_inbound', r.has_inbound,
        'needs_human_attention', coalesce(r.needs_human_attention, false),
        'escalation_reason', case when r.needs_human_attention then r.last_ai_escalation_reason else null end,
        'is_opted_out', r.is_opted_out,
        'is_test_traffic', r.is_test_traffic,
        'needs_outcome', r.needs_outcome,
        'ai_responder_status', r.ai_responder_status,
        'ai_responder_reason', r.ai_responder_reason,
        'ai_responder_status_at', r.ai_responder_status_at,
        'ai_last_delivery_status', r.ai_last_delivery_status,
        'ai_last_delivery_error', r.ai_last_delivery_error
      ) order by r.last_message_at desc, r.conversation_id
    ), '[]'::jsonb) as rows
    from page_rows r
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
  'RLS-scoped SMS inbox: authoritative full-window counts plus one bounded, server-filtered page.';
