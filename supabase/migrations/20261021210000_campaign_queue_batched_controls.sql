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
-- Callers loop until remaining_count = 0, passing the same p_op_id each call.
--
-- Operations. A campaign has at most one in-flight queue operation
-- (campaigns.queue_op_*), owned by the caller's p_op_id:
--   * A call whose p_op_id owns the op continues it. Its pace must match.
--   * A different op while the owner touched it in the last 2 minutes is
--     refused (55P03, "in progress") - except pause, which always preempts
--     and records the preempted op as cancelled; a cancelled op is refused
--     forever after.
--   * An op idle for 2 minutes may be taken over by a new op (retry after a
--     crash). A resume takeover must use the same pace (no mixed cadence);
--     its predecessors stay in queue_op_prev_ids so their rows still count as
--     this resume's prefix.
--   * The op is cleared on the call that leaves remaining_count = 0.
--
-- Ordering/continuity:
--   * resume: re-queued rows are tagged metadata.campaignResume.op. The next
--     batch starts one pace after the latest queued row tagged by this op
--     (or its predecessors), picking paused rows in the original order
--     (previousScheduledFor asc nulls last, created_at, id). It refuses while
--     any queued row is not tagged by this op chain (a pause that has not
--     finished, or rows from an older resume generation). The campaign flips
--     to 'completed' only on the final batch.
--   * cadence: rows are tagged metadata.campaignCadence = {op, orig}, orig
--     being the time before the FIRST pass that ever moved the row. Rows not
--     tagged by this op are processed ordered by orig when tagged, else by
--     scheduled_for, so untouched rows and rows moved by an abandoned pass
--     share one key space and the result matches the single-shot order.
--   * pause: the campaign flips to 'paused' on the FIRST batch, so the
--     sender's paused-campaign gate holds every due queued row even if a
--     later batch never runs. Pause strips campaignResume/campaignCadence.
--
-- p_limit null (the default) keeps the old unbounded single-statement
-- behaviour for any caller still on the old argument list.

begin;

alter table public.campaigns
  add column if not exists queue_op_id uuid,
  add column if not exists queue_op_kind text,
  add column if not exists queue_op_pace integer,
  add column if not exists queue_op_touched_at timestamptz,
  add column if not exists queue_op_prev_ids uuid[],
  add column if not exists queue_op_cancelled_id uuid;

drop function if exists public.pause_campaign_queue(uuid, boolean);
drop function if exists public.resume_campaign_queue(uuid, integer, integer, boolean);
drop function if exists public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean);

-- Internal: claim/continue/take over the campaign's queue op. Caller must
-- already hold the campaign row lock. Returns the op chain (current op plus
-- taken-over predecessors of the same kind).
create function public.campaign_queue_claim_op(
  p_campaign_id uuid,
  p_kind text,
  p_op_id uuid,
  p_pace integer
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  c record;
  v_prev uuid[];
begin
  select queue_op_id, queue_op_kind, queue_op_pace, queue_op_touched_at,
         queue_op_prev_ids, queue_op_cancelled_id
  into c
  from public.campaigns
  where id = p_campaign_id;

  if c.queue_op_cancelled_id = p_op_id then
    raise exception 'campaign queue operation was cancelled by a pause'
      using errcode = '55000';
  end if;

  if p_kind = 'pause' then
    if c.queue_op_id is not null and c.queue_op_kind <> 'pause' then
      update public.campaigns
      set queue_op_cancelled_id = c.queue_op_id
      where id = p_campaign_id;
    end if;
    if c.queue_op_id is distinct from p_op_id then
      update public.campaigns
      set queue_op_id = p_op_id, queue_op_kind = 'pause', queue_op_pace = null,
          queue_op_prev_ids = null
      where id = p_campaign_id;
    end if;
    update public.campaigns set queue_op_touched_at = v_now where id = p_campaign_id;
    return array[p_op_id];
  end if;

  if c.queue_op_id = p_op_id then
    if c.queue_op_kind <> p_kind or c.queue_op_pace is distinct from p_pace then
      raise exception 'campaign queue operation % changed kind or pace mid-run', p_op_id
        using errcode = '22023';
    end if;
    update public.campaigns set queue_op_touched_at = v_now where id = p_campaign_id;
    return array[p_op_id] || coalesce(c.queue_op_prev_ids, '{}');
  end if;

  if c.queue_op_id is not null and c.queue_op_touched_at > v_now - interval '2 minutes' then
    raise exception 'another campaign queue change (%) is in progress; try again shortly', c.queue_op_kind
      using errcode = '55P03';
  end if;

  v_prev := null;
  if c.queue_op_id is not null and c.queue_op_kind = p_kind and p_kind = 'resume' then
    if c.queue_op_pace is distinct from p_pace then
      raise exception 'an interrupted resume used % second pacing; resume again at % seconds to finish it',
        c.queue_op_pace, c.queue_op_pace
        using errcode = '22023';
    end if;
    v_prev := array[c.queue_op_id] || coalesce(c.queue_op_prev_ids, '{}');
  end if;

  update public.campaigns
  set queue_op_id = p_op_id,
      queue_op_kind = p_kind,
      queue_op_pace = p_pace,
      queue_op_touched_at = v_now,
      queue_op_prev_ids = v_prev
  where id = p_campaign_id;

  return array[p_op_id] || coalesce(v_prev, '{}');
end;
$$;

create function public.campaign_queue_finish_op(p_campaign_id uuid, p_op_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.campaigns
  set queue_op_id = null, queue_op_kind = null, queue_op_pace = null,
      queue_op_touched_at = null, queue_op_prev_ids = null
  where id = p_campaign_id
    and queue_op_id = p_op_id;
$$;

create function public.apply_campaign_cadence_reschedule(
  p_campaign_id uuid,
  p_pace_seconds integer,
  p_start_after_seconds integer default 300,
  p_operator_confirmed boolean default false,
  p_limit integer default null,
  p_op_id uuid default null
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
  v_op uuid := coalesce(p_op_id, gen_random_uuid());
  v_run_id text := v_op::text;
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

  if p_limit is not null and (p_limit < 1 or p_limit > 5000) then
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

  perform public.campaign_queue_claim_op(p_campaign_id, 'cadence', v_op, p_pace_seconds);

  select max(m.scheduled_for)
  into v_prev_last
  from public.messages m
  where m.campaign_id = p_campaign_id
    and m.org_id = v_org_id
    and m.channel = 'sms'
    and m.direction = 'outbound'
    and m.status = 'queued'
    and m.metadata #>> '{campaignCadence,op}' = v_run_id;

  v_start_at := case
    when v_prev_last is null then v_now + make_interval(secs => v_start_after_seconds)
    else greatest(v_prev_last + make_interval(secs => p_pace_seconds), v_now)
  end;

  with candidates as (
    select
      m.id,
      m.created_at,
      case
        when m.metadata ? 'campaignCadence'
          then nullif(m.metadata #>> '{campaignCadence,orig}', '')::timestamptz
        else m.scheduled_for
      end as order_key
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
      and (m.metadata #>> '{campaignCadence,op}') is distinct from v_run_id
  ),
  batch as (
    select m.id, candidates.order_key, m.created_at
    from candidates
    join public.messages m on m.id = candidates.id
    order by candidates.order_key asc nulls first, candidates.created_at asc, candidates.id asc
    limit coalesce(p_limit, 2147483647)
    for update of m
  ),
  planned as (
    select
      batch.id,
      v_start_at + (
        (row_number() over (
          order by batch.order_key asc nulls first, batch.created_at asc, batch.id asc
        ) - 1)::double precision * make_interval(secs => p_pace_seconds)
      ) as scheduled_for
    from batch
  ),
  updated as (
    update public.messages m
    set scheduled_for = planned.scheduled_for,
        metadata = (coalesce(m.metadata, '{}'::jsonb) - 'campaignCadence')
          || jsonb_build_object('campaignCadence', jsonb_build_object(
            'op', v_run_id,
            'orig', case
              when m.metadata ? 'campaignCadence'
                then m.metadata #>> '{campaignCadence,orig}'
              else m.scheduled_for::text
            end))
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
    and (m.metadata #>> '{campaignCadence,op}') is distinct from v_run_id;

  if v_remaining = 0 then
    if v_affected_count > 0 or v_prev_last is not null then
      update public.campaigns c
      set pace_seconds = p_pace_seconds,
          updated_at = clock_timestamp()
      where c.id = p_campaign_id
        and c.org_id = v_org_id;
    end if;
    perform public.campaign_queue_finish_op(p_campaign_id, v_op);
  end if;

  return query
  select v_affected_count, v_first_scheduled_for, v_last_scheduled_for, v_remaining;
end;
$$;

create function public.pause_campaign_queue(
  p_campaign_id uuid,
  p_operator_confirmed boolean default false,
  p_limit integer default null,
  p_op_id uuid default null
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
  v_op uuid := coalesce(p_op_id, gen_random_uuid());
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

  if p_limit is not null and (p_limit < 1 or p_limit > 5000) then
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

  perform public.campaign_queue_claim_op(p_campaign_id, 'pause', v_op, null);

  with batch as (
    select m.id
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
    order by m.scheduled_for asc nulls first, m.id asc
    limit coalesce(p_limit, 2147483647)
    for update of m
  ),
  paused as (
    update public.messages m
    set status = 'paused',
        scheduled_for = null,
        metadata = (coalesce(m.metadata, '{}'::jsonb) - 'campaignResume' - 'campaignCadence')
          || jsonb_build_object(
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

  -- Flip on the first batch: the sender re-pauses any due queued row of a
  -- paused campaign, so sends stay held even if a later batch never runs.
  update public.campaigns c
  set status = 'paused',
      updated_at = v_now
  where c.id = p_campaign_id
    and c.org_id = v_org_id
    and c.status <> 'archived';

  if v_remaining = 0 then
    perform public.campaign_queue_finish_op(p_campaign_id, v_op);
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
  p_limit integer default null,
  p_op_id uuid default null
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
  v_op uuid := coalesce(p_op_id, gen_random_uuid());
  v_chain text[];
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

  if p_limit is not null and (p_limit < 1 or p_limit > 5000) then
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

  select array_agg(x::text)
  into v_chain
  from unnest(public.campaign_queue_claim_op(p_campaign_id, 'resume', v_op, p_pace_seconds)) x;

  -- Queued rows not re-queued by this resume (or the interrupted resume it
  -- took over) mean a pause has not finished holding them.
  if exists (
    select 1
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
      and not coalesce(m.metadata #>> '{campaignResume,op}' = any (v_chain), false)
  ) then
    raise exception 'resume_campaign_queue: pause has not finished holding queued messages; pause again, then resume'
      using errcode = '55000';
  end if;

  select max(m.scheduled_for)
  into v_prev_last
  from public.messages m
  where m.campaign_id = p_campaign_id
    and m.org_id = v_org_id
    and m.channel = 'sms'
    and m.direction = 'outbound'
    and m.status = 'queued'
    and m.metadata #>> '{campaignResume,op}' = any (v_chain);

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
    limit coalesce(p_limit, 2147483647)
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
          || jsonb_build_object('campaignResume', jsonb_build_object(
            'op', v_op::text, 'resumedAt', v_now))
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
    perform public.campaign_queue_finish_op(p_campaign_id, v_op);
  end if;

  return query
  select v_affected_count, v_first_scheduled_for, v_last_scheduled_for, v_remaining;
end;
$$;

revoke all on function public.campaign_queue_claim_op(uuid, text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.campaign_queue_finish_op(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean, integer, uuid) from public, anon, authenticated;
revoke execute on function public.pause_campaign_queue(uuid, boolean, integer, uuid) from public, anon, authenticated;
revoke execute on function public.resume_campaign_queue(uuid, integer, integer, boolean, integer, uuid) from public, anon, authenticated;
grant execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean, integer, uuid) to service_role;
grant execute on function public.pause_campaign_queue(uuid, boolean, integer, uuid) to service_role;
grant execute on function public.resume_campaign_queue(uuid, integer, integer, boolean, integer, uuid) to service_role;

commit;
