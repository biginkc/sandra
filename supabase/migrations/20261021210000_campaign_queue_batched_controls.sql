-- Batched campaign queue controls.
--
-- pause_campaign_queue, resume_campaign_queue and
-- apply_campaign_cadence_reschedule used to rewrite every queued/paused
-- message of a campaign in ONE UPDATE. public.messages carries heavy
-- triggers, and service_role/authenticator run with an 8s statement_timeout
-- in production, so ~2,700 rows hit "canceling statement due to statement
-- timeout". A function-level SET statement_timeout does not extend the
-- already-running top-level statement, so the fix is to bound the work per
-- call: each call touches at most p_limit rows and returns remaining_count.
-- Callers loop until remaining_count = 0.
--
-- Cadence continuity across calls is derived from the database, not from
-- caller state:
--   * resume: rows it re-queues are tagged metadata.campaignResume. While the
--     campaign is still 'paused', the next call starts one pace after the
--     latest tagged queued row, so batches form one continuous cadence in
--     the same order as before (previousScheduledFor asc nulls last,
--     created_at, id). Two concurrent resumers serialize on the campaign row
--     lock and simply continue the same cadence; nothing is scheduled twice.
--     The campaign flips to 'completed' only on the call that leaves
--     remaining_count = 0.
--   * cadence: rows are tagged metadata.campaignCadenceRun = p_run_id. Rows
--     not yet tagged with this run keep their old scheduled_for, so the
--     untouched set is an exact suffix of the original order
--     (scheduled_for asc nulls first, created_at, id).
--   * pause: queued -> paused is naturally idempotent; the campaign flips to
--     'paused' only on the call that leaves remaining_count = 0. Pause strips
--     any campaignResume tag so a later resume starts fresh.

begin;

drop function if exists public.pause_campaign_queue(uuid, boolean);
drop function if exists public.resume_campaign_queue(uuid, integer, integer, boolean);
drop function if exists public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean);

create function public.apply_campaign_cadence_reschedule(
  p_campaign_id uuid,
  p_pace_seconds integer,
  p_start_after_seconds integer default 300,
  p_operator_confirmed boolean default false,
  p_limit integer default 100,
  p_run_id uuid default null
)
returns table (
  affected_count bigint,
  first_scheduled_for timestamptz,
  last_scheduled_for timestamptz,
  remaining_count bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_caller_id uuid := auth.uid();
  v_run_id text := coalesce(p_run_id, gen_random_uuid())::text;
  v_start_after_seconds integer := greatest(coalesce(p_start_after_seconds, 300), 0);
  v_now timestamptz := clock_timestamp();
  v_start_at timestamptz;
  v_prev_last timestamptz;
  v_affected_count bigint := 0;
  v_first_scheduled_for timestamptz;
  v_last_scheduled_for timestamptz;
  v_remaining bigint := 0;
begin
  if p_operator_confirmed is distinct from true then
    raise exception 'apply_campaign_cadence_reschedule: operator confirmation required'
      using errcode = '28000';
  end if;

  if p_pace_seconds is null or p_pace_seconds < 2 or p_pace_seconds > 600 then
    raise exception 'apply_campaign_cadence_reschedule: pace must be between 2 and 600 seconds'
      using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'apply_campaign_cadence_reschedule: limit must be between 1 and 5000'
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

  select max(m.scheduled_for)
  into v_prev_last
  from public.messages m
  where m.campaign_id = p_campaign_id
    and m.org_id = v_org_id
    and m.channel = 'sms'
    and m.direction = 'outbound'
    and m.status = 'queued'
    and m.metadata ->> 'campaignCadenceRun' = v_run_id;

  v_start_at := case
    when v_prev_last is null then v_now + make_interval(secs => v_start_after_seconds)
    else greatest(v_prev_last + make_interval(secs => p_pace_seconds), v_now)
  end;

  with batch as (
    select m.id, m.scheduled_for, m.created_at
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
      and (m.metadata ->> 'campaignCadenceRun') is distinct from v_run_id
    order by m.scheduled_for asc nulls first, m.created_at asc, m.id asc
    limit p_limit
    for update of m
  ),
  planned as (
    select
      batch.id,
      v_start_at + (
        (row_number() over (
          order by batch.scheduled_for asc nulls first, batch.created_at asc, batch.id asc
        ) - 1)::double precision * make_interval(secs => p_pace_seconds)
      ) as scheduled_for
    from batch
  ),
  updated as (
    update public.messages m
    set scheduled_for = planned.scheduled_for,
        metadata = coalesce(m.metadata, '{}'::jsonb)
          || jsonb_build_object('campaignCadenceRun', v_run_id)
    from planned
    where m.id = planned.id
    returning m.scheduled_for
  )
  select
    count(updated.scheduled_for)::bigint,
    min(updated.scheduled_for),
    max(updated.scheduled_for)
  into v_affected_count, v_first_scheduled_for, v_last_scheduled_for
  from updated;

  select count(*)::bigint
  into v_remaining
  from public.messages m
  where m.campaign_id = p_campaign_id
    and m.org_id = v_org_id
    and m.channel = 'sms'
    and m.direction = 'outbound'
    and m.status = 'queued'
    and (m.metadata ->> 'campaignCadenceRun') is distinct from v_run_id;

  if v_remaining = 0 and (v_affected_count > 0 or v_prev_last is not null) then
    update public.campaigns c
    set pace_seconds = p_pace_seconds,
        updated_at = clock_timestamp()
    where c.id = p_campaign_id
      and c.org_id = v_org_id;
  end if;

  return query
  select v_affected_count, v_first_scheduled_for, v_last_scheduled_for, v_remaining;
end;
$$;

create function public.pause_campaign_queue(
  p_campaign_id uuid,
  p_operator_confirmed boolean default false,
  p_limit integer default 100
)
returns table (
  affected_count bigint,
  pending_count bigint,
  paused_count bigint,
  remaining_count bigint
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
  v_remaining bigint := 0;
begin
  if p_operator_confirmed is distinct from true then
    raise exception 'pause_campaign_queue: operator confirmation required'
      using errcode = '28000';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'pause_campaign_queue: limit must be between 1 and 5000'
      using errcode = '22023';
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

  with batch as (
    select m.id
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
    order by m.scheduled_for asc nulls first, m.id asc
    limit p_limit
    for update of m
  ),
  paused as (
    update public.messages m
    set status = 'paused',
        scheduled_for = null,
        metadata = (coalesce(m.metadata, '{}'::jsonb) - 'campaignResume') || jsonb_build_object(
          'campaignPause',
          jsonb_build_object(
            'pausedAt', v_now,
            'previousScheduledFor', m.scheduled_for,
            'reason', 'operator_pause'
          )
        )
    from batch
    where m.id = batch.id
    returning 1
  )
  select count(*)::bigint
  into v_affected_count
  from paused;

  select count(*)::bigint
  into v_remaining
  from public.messages m
  where m.campaign_id = p_campaign_id
    and m.org_id = v_org_id
    and m.channel = 'sms'
    and m.direction = 'outbound'
    and m.status = 'queued';

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

  if v_remaining = 0 then
    update public.campaigns c
    set status = 'paused',
        updated_at = v_now
    where c.id = p_campaign_id
      and c.org_id = v_org_id
      and c.status <> 'archived';
  end if;

  return query
  select v_affected_count, v_pending_count, v_paused_count, v_remaining;
end;
$$;

create function public.resume_campaign_queue(
  p_campaign_id uuid,
  p_pace_seconds integer,
  p_start_after_seconds integer default 300,
  p_operator_confirmed boolean default false,
  p_limit integer default 100
)
returns table (
  affected_count bigint,
  first_scheduled_for timestamptz,
  last_scheduled_for timestamptz,
  remaining_count bigint
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
  v_start_at timestamptz;
  v_prev_last timestamptz;
  v_affected_count bigint := 0;
  v_first_scheduled_for timestamptz;
  v_last_scheduled_for timestamptz;
  v_remaining bigint := 0;
begin
  if p_operator_confirmed is distinct from true then
    raise exception 'resume_campaign_queue: operator confirmation required'
      using errcode = '28000';
  end if;

  if p_pace_seconds is null or p_pace_seconds < 2 or p_pace_seconds > 600 then
    raise exception 'resume_campaign_queue: pace must be between 2 and 600 seconds'
      using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'resume_campaign_queue: limit must be between 1 and 5000'
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

  -- An in-progress resume (earlier batch, possibly from another caller) has
  -- already re-queued tagged rows while the campaign is still paused:
  -- continue its cadence one pace after the latest of them.
  select max(m.scheduled_for)
  into v_prev_last
  from public.messages m
  where m.campaign_id = p_campaign_id
    and m.org_id = v_org_id
    and m.channel = 'sms'
    and m.direction = 'outbound'
    and m.status = 'queued'
    and m.metadata ? 'campaignResume';

  v_start_at := case
    when v_prev_last is null then v_now + make_interval(secs => v_start_after_seconds)
    else greatest(v_prev_last + make_interval(secs => p_pace_seconds), v_now)
  end;

  with batch as (
    select
      m.id,
      nullif(m.metadata #>> '{campaignPause,previousScheduledFor}', '')::timestamptz
        as previous_scheduled_for,
      m.created_at
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'paused'
    order by
      nullif(m.metadata #>> '{campaignPause,previousScheduledFor}', '')::timestamptz asc nulls last,
      m.created_at asc,
      m.id asc
    limit p_limit
    for update of m
  ),
  planned as (
    select
      batch.id,
      v_start_at + (
        (row_number() over (
          order by batch.previous_scheduled_for asc nulls last, batch.created_at asc, batch.id asc
        ) - 1)::double precision * make_interval(secs => p_pace_seconds)
      ) as scheduled_for
    from batch
  ),
  updated as (
    update public.messages m
    set status = 'queued',
        scheduled_for = planned.scheduled_for,
        metadata = (coalesce(m.metadata, '{}'::jsonb) - 'campaignPause')
          || jsonb_build_object('campaignResume', jsonb_build_object('resumedAt', v_now))
    from planned
    where m.id = planned.id
    returning m.scheduled_for
  )
  select
    count(updated.scheduled_for)::bigint,
    min(updated.scheduled_for),
    max(updated.scheduled_for)
  into v_affected_count, v_first_scheduled_for, v_last_scheduled_for
  from updated;

  select count(*)::bigint
  into v_remaining
  from public.messages m
  where m.campaign_id = p_campaign_id
    and m.org_id = v_org_id
    and m.channel = 'sms'
    and m.direction = 'outbound'
    and m.status = 'paused';

  if v_remaining = 0 then
    update public.campaigns c
    set status = 'completed',
        pace_seconds = p_pace_seconds,
        updated_at = clock_timestamp()
    where c.id = p_campaign_id
      and c.org_id = v_org_id;
  end if;

  return query
  select v_affected_count, v_first_scheduled_for, v_last_scheduled_for, v_remaining;
end;
$$;

revoke execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean, integer, uuid) from public;
revoke execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean, integer, uuid) from anon;
revoke execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean, integer, uuid) from authenticated;
revoke execute on function public.pause_campaign_queue(uuid, boolean, integer) from public;
revoke execute on function public.pause_campaign_queue(uuid, boolean, integer) from anon;
revoke execute on function public.pause_campaign_queue(uuid, boolean, integer) from authenticated;
revoke execute on function public.resume_campaign_queue(uuid, integer, integer, boolean, integer) from public;
revoke execute on function public.resume_campaign_queue(uuid, integer, integer, boolean, integer) from anon;
revoke execute on function public.resume_campaign_queue(uuid, integer, integer, boolean, integer) from authenticated;
grant execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean, integer, uuid) to service_role;
grant execute on function public.pause_campaign_queue(uuid, boolean, integer) to service_role;
grant execute on function public.resume_campaign_queue(uuid, integer, integer, boolean, integer) to service_role;

commit;
