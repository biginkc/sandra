begin;

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
  if p_pace_seconds is null or p_pace_seconds < 1 or p_pace_seconds > 600 then
    raise exception 'preview_campaign_cadence_reschedule: pace must be between 1 and 600 seconds'
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
        order by m.scheduled_for asc nulls last, m.created_at asc, m.id asc
      ) - 1 as ordinal
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
      and m.scheduled_for is not null
      and m.scheduled_for > v_now
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

  if p_pace_seconds is null or p_pace_seconds < 1 or p_pace_seconds > 600 then
    raise exception 'apply_campaign_cadence_reschedule: pace must be between 1 and 600 seconds'
      using errcode = '22023';
  end if;

  select c.org_id
  into v_org_id
  from public.campaigns c
  where c.id = p_campaign_id;

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
        order by m.scheduled_for asc nulls last, m.created_at asc, m.id asc
      ) - 1 as ordinal
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
      and m.scheduled_for is not null
      and m.scheduled_for > v_now
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

revoke execute on function public.preview_campaign_cadence_reschedule(uuid, integer, integer) from public;
revoke execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean) from public;
revoke execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean) from authenticated;
grant execute on function public.preview_campaign_cadence_reschedule(uuid, integer, integer) to authenticated;
grant execute on function public.preview_campaign_cadence_reschedule(uuid, integer, integer) to service_role;
grant execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean) to service_role;

commit;
