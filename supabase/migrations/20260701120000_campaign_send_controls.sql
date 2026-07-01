begin;

alter table public.messages
  drop constraint if exists messages_status_check;

alter table public.messages
  add constraint messages_status_check
  check (
    status in (
      'pending',
      'queued',
      'paused',
      'sent',
      'delivered',
      'failed',
      'received',
      'bounced'
    )
  ) not valid;

alter table public.messages
  validate constraint messages_status_check;

create index if not exists idx_messages_campaign_queue_controls
  on public.messages (campaign_id, status, scheduled_for)
  where campaign_id is not null
    and channel = 'sms'
    and direction = 'outbound'
    and status in ('queued', 'paused');

create or replace function public.preview_campaign_cadence_reschedule(
  p_campaign_id uuid,
  p_pace_seconds integer,
  p_start_after_seconds integer default 300
)
returns table (
  affected_count bigint,
  first_scheduled_for timestamptz,
  last_scheduled_for timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_caller_id uuid := auth.uid();
  v_start_after_seconds integer := greatest(coalesce(p_start_after_seconds, 300), 0);
  v_now timestamptz := clock_timestamp();
  v_start_at timestamptz := v_now + make_interval(secs => v_start_after_seconds);
begin
  if p_pace_seconds is null or p_pace_seconds < 2 or p_pace_seconds > 600 then
    raise exception 'preview_campaign_cadence_reschedule: pace must be between 2 and 600 seconds'
      using errcode = '22023';
  end if;

  select c.org_id
  into v_org_id
  from public.campaigns c
  where c.id = p_campaign_id;

  if v_org_id is null then
    raise exception 'preview_campaign_cadence_reschedule: campaign % not found', p_campaign_id
      using errcode = 'P0002';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_caller_id is null then
      raise exception 'preview_campaign_cadence_reschedule: authenticated user required'
        using errcode = '28000';
    end if;

    if not exists (
      select 1
      from public.memberships m
      where m.user_id = v_caller_id
        and m.org_id = v_org_id
    ) then
      raise exception 'preview_campaign_cadence_reschedule: caller is not authorized for org %', v_org_id
        using errcode = '42501';
    end if;
  end if;

  return query
  with remaining as (
    select
      m.id,
      row_number() over (
        order by m.scheduled_for asc nulls first, m.created_at asc, m.id asc
      ) - 1 as ordinal
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
  ),
  planned as (
    select
      v_start_at + (remaining.ordinal::double precision * make_interval(secs => p_pace_seconds))
        as scheduled_for
    from remaining
  )
  select
    count(*)::bigint,
    min(planned.scheduled_for),
    max(planned.scheduled_for)
  from planned;
end;
$$;

create or replace function public.apply_campaign_cadence_reschedule(
  p_campaign_id uuid,
  p_pace_seconds integer,
  p_start_after_seconds integer default 300,
  p_operator_confirmed boolean default false
)
returns table (
  affected_count bigint,
  first_scheduled_for timestamptz,
  last_scheduled_for timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_caller_id uuid := auth.uid();
  v_start_after_seconds integer := greatest(coalesce(p_start_after_seconds, 300), 0);
  v_now timestamptz := clock_timestamp();
  v_start_at timestamptz := v_now + make_interval(secs => v_start_after_seconds);
  v_affected_count bigint := 0;
  v_first_scheduled_for timestamptz;
  v_last_scheduled_for timestamptz;
begin
  if p_operator_confirmed is distinct from true then
    raise exception 'apply_campaign_cadence_reschedule: operator confirmation required'
      using errcode = '28000';
  end if;

  if p_pace_seconds is null or p_pace_seconds < 2 or p_pace_seconds > 600 then
    raise exception 'apply_campaign_cadence_reschedule: pace must be between 2 and 600 seconds'
      using errcode = '22023';
  end if;

  select c.org_id
  into v_org_id
  from public.campaigns c
  where c.id = p_campaign_id
  for update;

  if v_org_id is null then
    raise exception 'apply_campaign_cadence_reschedule: campaign % not found', p_campaign_id
      using errcode = 'P0002';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_caller_id is null then
      raise exception 'apply_campaign_cadence_reschedule: authenticated user required'
        using errcode = '28000';
    end if;

    if not exists (
      select 1
      from public.memberships m
      where m.user_id = v_caller_id
        and m.org_id = v_org_id
    ) then
      raise exception 'apply_campaign_cadence_reschedule: caller is not authorized for org %', v_org_id
        using errcode = '42501';
    end if;
  end if;

  with remaining as (
    select
      m.id,
      row_number() over (
        order by m.scheduled_for asc nulls first, m.created_at asc, m.id asc
      ) - 1 as ordinal
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
  ),
  planned as (
    select
      remaining.id,
      v_start_at + (remaining.ordinal::double precision * make_interval(secs => p_pace_seconds))
        as scheduled_for
    from remaining
  ),
  updated as (
    update public.messages m
    set scheduled_for = planned.scheduled_for
    from planned
    where m.id = planned.id
      and m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
    returning m.scheduled_for
  )
  select
    count(updated.scheduled_for)::bigint,
    min(updated.scheduled_for),
    max(updated.scheduled_for)
  into v_affected_count, v_first_scheduled_for, v_last_scheduled_for
  from updated;

  if v_affected_count > 0 then
    update public.campaigns c
    set pace_seconds = p_pace_seconds,
        updated_at = clock_timestamp()
    where c.id = p_campaign_id
      and c.org_id = v_org_id;
  end if;

  return query
  select v_affected_count, v_first_scheduled_for, v_last_scheduled_for;
end;
$$;

create or replace function public.pause_campaign_queue(
  p_campaign_id uuid,
  p_operator_confirmed boolean default false
)
returns table (
  affected_count bigint,
  pending_count bigint,
  paused_count bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_campaign_status text;
  v_caller_id uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_affected_count bigint := 0;
  v_pending_count bigint := 0;
  v_paused_count bigint := 0;
begin
  if p_operator_confirmed is distinct from true then
    raise exception 'pause_campaign_queue: operator confirmation required'
      using errcode = '28000';
  end if;

  select c.org_id, c.status
  into v_org_id, v_campaign_status
  from public.campaigns c
  where c.id = p_campaign_id
  for update;

  if v_org_id is null then
    raise exception 'pause_campaign_queue: campaign % not found', p_campaign_id
      using errcode = 'P0002';
  end if;

  if v_campaign_status = 'archived' then
    raise exception 'pause_campaign_queue: archived campaigns cannot be paused'
      using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_caller_id is null then
      raise exception 'pause_campaign_queue: authenticated user required'
        using errcode = '28000';
    end if;

    if not exists (
      select 1
      from public.memberships m
      where m.user_id = v_caller_id
        and m.org_id = v_org_id
    ) then
      raise exception 'pause_campaign_queue: caller is not authorized for org %', v_org_id
        using errcode = '42501';
    end if;
  end if;

  with paused as (
    update public.messages m
    set status = 'paused',
        scheduled_for = null,
        metadata = coalesce(m.metadata, '{}'::jsonb) || jsonb_build_object(
          'campaignPause',
          jsonb_build_object(
            'pausedAt', v_now,
            'previousScheduledFor', m.scheduled_for,
            'reason', 'operator_pause'
          )
        )
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
    returning 1
  )
  select count(*)::bigint
  into v_affected_count
  from paused;

  select count(*)::bigint
  into v_pending_count
  from public.messages m
  where m.campaign_id = p_campaign_id
    and m.org_id = v_org_id
    and m.channel = 'sms'
    and m.direction = 'outbound'
    and m.status = 'pending';

  select count(*)::bigint
  into v_paused_count
  from public.messages m
  where m.campaign_id = p_campaign_id
    and m.org_id = v_org_id
    and m.channel = 'sms'
    and m.direction = 'outbound'
    and m.status = 'paused';

  if v_affected_count = 0 and v_pending_count = 0 and v_paused_count = 0 then
    raise exception 'pause_campaign_queue: campaign has no queued, pending, or paused messages to hold'
      using errcode = '22023';
  end if;

  update public.campaigns c
  set status = 'paused',
      updated_at = v_now
  where c.id = p_campaign_id
    and c.org_id = v_org_id
    and c.status <> 'archived';

  return query
  select v_affected_count, v_pending_count, v_paused_count;
end;
$$;

create or replace function public.resume_campaign_queue(
  p_campaign_id uuid,
  p_pace_seconds integer,
  p_start_after_seconds integer default 300,
  p_operator_confirmed boolean default false
)
returns table (
  affected_count bigint,
  first_scheduled_for timestamptz,
  last_scheduled_for timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_campaign_status text;
  v_caller_id uuid := auth.uid();
  v_start_after_seconds integer := greatest(coalesce(p_start_after_seconds, 300), 0);
  v_now timestamptz := clock_timestamp();
  v_start_at timestamptz := v_now + make_interval(secs => v_start_after_seconds);
  v_affected_count bigint := 0;
  v_first_scheduled_for timestamptz;
  v_last_scheduled_for timestamptz;
begin
  if p_operator_confirmed is distinct from true then
    raise exception 'resume_campaign_queue: operator confirmation required'
      using errcode = '28000';
  end if;

  if p_pace_seconds is null or p_pace_seconds < 2 or p_pace_seconds > 600 then
    raise exception 'resume_campaign_queue: pace must be between 2 and 600 seconds'
      using errcode = '22023';
  end if;

  select c.org_id, c.status
  into v_org_id, v_campaign_status
  from public.campaigns c
  where c.id = p_campaign_id
  for update;

  if v_org_id is null then
    raise exception 'resume_campaign_queue: campaign % not found', p_campaign_id
      using errcode = 'P0002';
  end if;

  if v_campaign_status = 'archived' then
    raise exception 'resume_campaign_queue: archived campaigns cannot be resumed'
      using errcode = '22023';
  end if;

  if v_campaign_status <> 'paused' then
    raise exception 'resume_campaign_queue: campaign is %, not paused', v_campaign_status
      using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_caller_id is null then
      raise exception 'resume_campaign_queue: authenticated user required'
        using errcode = '28000';
    end if;

    if not exists (
      select 1
      from public.memberships m
      where m.user_id = v_caller_id
        and m.org_id = v_org_id
    ) then
      raise exception 'resume_campaign_queue: caller is not authorized for org %', v_org_id
        using errcode = '42501';
    end if;
  end if;

  with remaining as (
    select
      m.id,
      row_number() over (
        order by
          nullif(m.metadata #>> '{campaignPause,previousScheduledFor}', '')::timestamptz asc nulls last,
          m.created_at asc,
          m.id asc
      ) - 1 as ordinal
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'paused'
  ),
  planned as (
    select
      remaining.id,
      v_start_at + (remaining.ordinal::double precision * make_interval(secs => p_pace_seconds))
        as scheduled_for
    from remaining
  ),
  updated as (
    update public.messages m
    set status = 'queued',
        scheduled_for = planned.scheduled_for,
        metadata = coalesce(m.metadata, '{}'::jsonb) - 'campaignPause'
    from planned
    where m.id = planned.id
      and m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'paused'
    returning m.scheduled_for
  )
  select
    count(updated.scheduled_for)::bigint,
    min(updated.scheduled_for),
    max(updated.scheduled_for)
  into v_affected_count, v_first_scheduled_for, v_last_scheduled_for
  from updated;

  update public.campaigns c
  set status = 'completed',
      pace_seconds = p_pace_seconds,
      updated_at = clock_timestamp()
  where c.id = p_campaign_id
    and c.org_id = v_org_id;

  return query
  select v_affected_count, v_first_scheduled_for, v_last_scheduled_for;
end;
$$;

revoke execute on function public.pause_campaign_queue(uuid, boolean) from public;
revoke execute on function public.pause_campaign_queue(uuid, boolean) from authenticated;
revoke execute on function public.resume_campaign_queue(uuid, integer, integer, boolean) from public;
revoke execute on function public.resume_campaign_queue(uuid, integer, integer, boolean) from authenticated;
grant execute on function public.pause_campaign_queue(uuid, boolean) to service_role;
grant execute on function public.resume_campaign_queue(uuid, integer, integer, boolean) to service_role;

commit;
