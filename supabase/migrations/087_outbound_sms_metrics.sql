-- Collapse the live outbound queue metrics fan-out into one RLS-scoped scan.
-- SECURITY INVOKER is intentional: the caller's messages SELECT policy remains
-- the tenancy boundary, including for users with multiple memberships.

begin;

create or replace function public.outbound_sms_metrics(
  p_campaign_id uuid default null,
  p_org_id uuid default null,
  p_now timestamptz default now(),
  p_day_start timestamptz default null,
  p_day_end timestamptz default null
)
returns table (
  outbound_rows bigint,
  queued bigint,
  paused bigint,
  due_queued bigint,
  pending bigint,
  sent bigint,
  delivered bigint,
  failed bigint,
  failed_after_handoff bigint,
  handed_off_via_sent_at_today bigint,
  delivered_without_sent_at_today bigint,
  failed_today bigint,
  next_scheduled_for timestamptz,
  last_scheduled_for timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with scoped_messages as (
    select m.*
    from public.messages m
    where m.channel = 'sms'
      and m.direction = 'outbound'
      and (p_campaign_id is null or m.campaign_id = p_campaign_id)
      and (p_org_id is null or m.org_id = p_org_id)
  )
  select
    count(*)::bigint as outbound_rows,
    count(*) filter (where status = 'queued')::bigint as queued,
    count(*) filter (where status = 'paused')::bigint as paused,
    count(*) filter (
      where status = 'queued'
        and scheduled_for is not null
        and scheduled_for <= p_now
    )::bigint as due_queued,
    count(*) filter (where status = 'pending')::bigint as pending,
    count(*) filter (where status = 'sent')::bigint as sent,
    count(*) filter (where status = 'delivered')::bigint as delivered,
    count(*) filter (where status = 'failed')::bigint as failed,
    count(*) filter (
      where status = 'failed' and sent_at is not null
    )::bigint as failed_after_handoff,
    count(*) filter (
      where sent_at is not null
        and sent_at >= p_day_start
        and sent_at < p_day_end
    )::bigint as handed_off_via_sent_at_today,
    count(*) filter (
      where status = 'delivered'
        and sent_at is null
        and delivered_at is not null
        and delivered_at >= p_day_start
        and delivered_at < p_day_end
    )::bigint as delivered_without_sent_at_today,
    count(*) filter (
      where status = 'failed'
        and failed_at is not null
        and failed_at >= p_day_start
        and failed_at < p_day_end
    )::bigint as failed_today,
    min(scheduled_for) filter (
      where status = 'queued' and scheduled_for is not null
    ) as next_scheduled_for,
    max(scheduled_for) filter (
      where status = 'queued' and scheduled_for is not null
    ) as last_scheduled_for
  from scoped_messages;
$$;

revoke all on function public.outbound_sms_metrics(uuid, uuid, timestamptz, timestamptz, timestamptz)
  from public, anon, service_role;
grant execute on function public.outbound_sms_metrics(uuid, uuid, timestamptz, timestamptz, timestamptz)
  to authenticated;

commit;
