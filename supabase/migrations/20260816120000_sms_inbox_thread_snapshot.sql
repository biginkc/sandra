-- Return the complete SMS inbox snapshot as one JSON value. PostgREST limits
-- row-returning endpoints to 1,000 rows by default; a scalar JSON document
-- keeps thread grouping, unread totals, and filter counts correct above that
-- boundary while PostgreSQL evaluates the whole window in one statement.
--
-- SECURITY INVOKER is intentional. Every joined table keeps its RLS policy,
-- so authenticated callers can see only organizations in their memberships.
create or replace function public.sms_inbox_thread_snapshot(
  p_cutoff timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    -- Callers may tighten the product window, never expand it past one year.
    select greatest(
      coalesce(p_cutoff, statement_timestamp() - interval '365 days'),
      statement_timestamp() - interval '365 days'
    ) as cutoff
  ),
  eligible as (
    select
      m.*,
      row_number() over (
        partition by m.conversation_id
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
    group by e.conversation_id
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
      ce.event_type as latest_consent_event
    from grouped g
    left join public.contacts c on c.id = g.contact_id
    left join public.properties p on p.id = g.property_id
    left join public.message_threads mt on mt.conversation_id = g.conversation_id
    left join lateral (
      select consent.event_type
      from public.consent_events consent
      where consent.contact_id = g.contact_id
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
  ),
  snapshot_meta as (
    select count(*)::integer as thread_count from hydrated
  ),
  payload as (
    -- Never truncate silently. Above the server-owned ceiling, skip JSON
    -- materialization and return a small error sentinel that the application
    -- converts to a failed request.
    select jsonb_agg(
      jsonb_build_object(
        'thread_id', h.conversation_id,
        'contact_id', h.contact_id,
        'contact_name', h.contact_name,
        'thread_customer_phone', case
          when h.last_message_direction = 'inbound' then h.latest_from
          else h.latest_to
        end,
        'thread_business_phone', case
          when h.last_message_direction = 'inbound' then h.latest_to
          else h.latest_from
        end,
        'property_id', h.property_id,
        'property_address', nullif(concat_ws(', ', h.address, h.city, h.state), ''),
        'property_status', h.property_status,
        'outreach_dispo', h.outreach_dispo,
        'is_dnc_locked', coalesce(h.is_dnc_locked, false),
        'assignee_id', h.assigned_user_id,
        'last_message_body', h.last_message_body,
        'last_message_direction', h.last_message_direction,
        'last_message_at', h.last_message_at,
        'unread_count', h.unread_count,
        'has_inbound', h.has_inbound,
        'needs_human_attention', coalesce(h.needs_human_attention, false),
        'escalation_reason', case
          when h.needs_human_attention then h.last_ai_escalation_reason
          else null
        end,
        'is_opted_out', coalesce(h.do_not_contact, false)
          or coalesce(h.sms_opted_out, false)
          or coalesce(
            h.latest_consent_event in ('opt_out', 'provider_auto_opt_out'),
            false
          ),
        'ai_responder_status', h.ai_responder_status,
        'ai_responder_reason', h.ai_responder_reason,
        'ai_responder_status_at', h.ai_responder_status_at,
        'ai_last_delivery_status', h.ai_last_delivery_status,
        'ai_last_delivery_error', h.ai_last_delivery_error
      )
      order by h.last_message_at desc, h.conversation_id
    ) as document
    from hydrated h
    cross join snapshot_meta meta
    where meta.thread_count <= 20000
  )
  select case
    when meta.thread_count > 20000 then jsonb_build_object(
      '__error', 'thread_limit_exceeded',
      'limit', 20000,
      'count', meta.thread_count
    )
    else coalesce(payload.document, '[]'::jsonb)
  end
  from snapshot_meta meta
  cross join payload;
$$;

revoke all on function public.sms_inbox_thread_snapshot(timestamptz) from public;
revoke all on function public.sms_inbox_thread_snapshot(timestamptz) from anon;
grant execute on function public.sms_inbox_thread_snapshot(timestamptz) to authenticated;
grant execute on function public.sms_inbox_thread_snapshot(timestamptz) to service_role;

comment on function public.sms_inbox_thread_snapshot(timestamptz) is
  'RLS-scoped, single-statement SMS inbox snapshot returned as JSON to avoid PostgREST row caps.';
