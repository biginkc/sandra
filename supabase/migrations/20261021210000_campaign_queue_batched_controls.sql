-- Batched campaign queue controls.
--
-- pause_campaign_queue, resume_campaign_queue and
-- apply_campaign_cadence_reschedule used to rewrite every queued/paused
-- message of a campaign in ONE UPDATE. public.messages carries heavy
-- triggers, and service_role/authenticator run with an 8s statement_timeout
-- in production, so ~2,700 rows hit "canceling statement due to statement
-- timeout". A function-level SET statement_timeout does not extend the
-- already-running top-level statement, so the fix is to bound the message
-- writes per call: each call touches at most p_limit messages and returns
-- remaining_count. Callers loop, passing the same p_op_id on every call.
--
-- Resume and cadence are OPERATIONS (campaign_queue_ops):
--   * The first call builds the whole schedule into campaign_queue_plan in
--     one cheap insert (no message triggers), using exactly the single-shot
--     order and spacing. Later calls only copy the next p_limit planned times
--     onto messages, so order and cadence are fixed at plan time and cannot
--     drift across batches, retries, or sender activity.
--   * One active op per campaign. A call with a known op id continues it
--     (same kind and pace) only while it is active; done / cancelled /
--     superseded ops are refused forever. A different op is refused while
--     the active one was touched in the last 2 minutes (55P03). After that
--     it may take over (crash retry): same kind inherits the plan order (a
--     resume takeover must use the same pace; a cadence takeover re-times
--     every planned row at its own pace), and the old op is superseded.
--   * Pause preempts: it cancels any active resume/cadence op. Pause itself
--     is idempotent and needs no op. It flips the campaign to 'paused' on its
--     FIRST batch, so the sender's paused-campaign gate holds every due
--     queued row even if a later batch never runs.
--   * Resume refuses to start while any queued row remains (a pause that has
--     not finished). It re-queues planned rows that are still paused (rows
--     the sender re-paused mid-resume are re-applied with their planned
--     time) and flips the campaign to 'completed' only on the final batch.
--   * Cadence holds the campaign for the whole pass with the existing pause
--     gate: the first call sets the campaign 'paused' (remembering its prior
--     status), each call first re-holds planned rows still queued on their
--     old time, then releases planned rows at their new time; the prior
--     status is restored on the final batch. An abandoned pass leaves the
--     campaign paused (nothing sends on a half-written schedule) until a
--     retry takes it over or an operator pauses/resumes.
--   * A takeover (resume or cadence) re-times the inherited plan from now,
--     in the same order, so a late retry never queues rows in the past.
--   * Known pre-existing race (unchanged from the single-shot version): a
--     sender that read 'paused' just before the final batch commits can
--     re-pause one row after completion; pausing and resuming again fixes it.
--
-- p_limit null (the default) keeps the old unbounded single-statement
-- behaviour for any caller still on the old argument list.

begin;

create table if not exists public.campaign_queue_ops (
  id uuid primary key,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  kind text not null check (kind in ('resume', 'cadence')),
  pace_seconds integer not null,
  prior_campaign_status text,
  state text not null default 'active'
    check (state in ('active', 'done', 'cancelled', 'superseded')),
  created_at timestamptz not null default now(),
  touched_at timestamptz not null default now()
);

create unique index if not exists campaign_queue_ops_one_active
  on public.campaign_queue_ops (campaign_id)
  where state = 'active';

create table if not exists public.campaign_queue_plan (
  op_id uuid not null references public.campaign_queue_ops (id) on delete cascade,
  seq integer not null,
  message_id uuid not null,
  scheduled_for timestamptz not null,
  applied boolean not null default false,
  primary key (op_id, seq)
);

alter table public.campaign_queue_ops enable row level security;
alter table public.campaign_queue_plan enable row level security;
revoke all on table public.campaign_queue_ops from public, anon, authenticated;
revoke all on table public.campaign_queue_plan from public, anon, authenticated;
grant select, insert, update, delete on table public.campaign_queue_ops to service_role;
grant select, insert, update, delete on table public.campaign_queue_plan to service_role;

drop function if exists public.pause_campaign_queue(uuid, boolean);
drop function if exists public.resume_campaign_queue(uuid, integer, integer, boolean);
drop function if exists public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean);

-- Internal. Caller holds the campaign row lock. Returns 'new' (build a plan),
-- 'inherit' (plan taken over from an abandoned op of the same kind) or
-- 'continue'.
create function public.campaign_queue_claim_op(
  p_campaign_id uuid,
  p_kind text,
  p_op_id uuid,
  p_pace integer
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_mine public.campaign_queue_ops%rowtype;
  v_active public.campaign_queue_ops%rowtype;
begin
  select * into v_mine from public.campaign_queue_ops where id = p_op_id;
  if found then
    if v_mine.campaign_id <> p_campaign_id or v_mine.kind <> p_kind or v_mine.pace_seconds <> p_pace then
      raise exception 'campaign queue operation % does not match this request', p_op_id
        using errcode = '22023';
    end if;
    if v_mine.state <> 'active' then
      raise exception 'campaign queue operation is %; start a new one', v_mine.state
        using errcode = '55000';
    end if;
    update public.campaign_queue_ops set touched_at = v_now where id = p_op_id;
    return 'continue';
  end if;

  select * into v_active
  from public.campaign_queue_ops
  where campaign_id = p_campaign_id and state = 'active';

  if not found then
    insert into public.campaign_queue_ops (id, campaign_id, kind, pace_seconds, touched_at)
    values (p_op_id, p_campaign_id, p_kind, p_pace, v_now);
    return 'new';
  end if;

  if v_active.touched_at > v_now - interval '2 minutes' then
    raise exception 'another campaign queue change (%) is in progress; try again in 2 minutes', v_active.kind
      using errcode = '55P03';
  end if;

  if v_active.kind = 'resume' and p_kind = 'resume' and v_active.pace_seconds <> p_pace then
    raise exception 'an interrupted resume used % second pacing; resume again at % seconds to finish it',
      v_active.pace_seconds, v_active.pace_seconds
      using errcode = '22023';
  end if;

  update public.campaign_queue_ops set state = 'superseded' where id = v_active.id;
  insert into public.campaign_queue_ops
    (id, campaign_id, kind, pace_seconds, touched_at, prior_campaign_status, created_at)
  values (p_op_id, p_campaign_id, p_kind, p_pace, v_now,
          case when v_active.kind = p_kind then v_active.prior_campaign_status end,
          case when v_active.kind = p_kind then v_active.created_at else v_now end);

  if v_active.kind = p_kind then
    update public.campaign_queue_plan set op_id = p_op_id where op_id = v_active.id;
    return 'inherit';
  end if;

  delete from public.campaign_queue_plan where op_id = v_active.id;
  return 'new';
end;
$$;

create function public.campaign_queue_finish_op(p_op_id uuid, p_state text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.campaign_queue_plan where op_id = p_op_id;
  update public.campaign_queue_ops set state = p_state, touched_at = clock_timestamp()
  where id = p_op_id and state = 'active';
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
  v_start_after_seconds integer := greatest(coalesce(p_start_after_seconds, 300), 0);
  v_now timestamptz := clock_timestamp();
  v_start_at timestamptz := v_now + make_interval(secs => v_start_after_seconds);
  v_affected_count bigint := 0;
  v_first_scheduled_for timestamptz;
  v_last_scheduled_for timestamptz;
  v_remaining bigint := 0;
  v_ever_applied boolean;
  v_claim text;
  v_held bigint := 0;
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

  v_claim := public.campaign_queue_claim_op(p_campaign_id, 'cadence', v_op, p_pace_seconds);

  if v_claim = 'new' then
    insert into public.campaign_queue_plan (op_id, seq, message_id, scheduled_for)
    select
      v_op,
      (row_number() over w - 1)::integer,
      m.id,
      v_start_at + ((row_number() over w - 1)::double precision * make_interval(secs => p_pace_seconds))
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'queued'
    window w as (order by m.scheduled_for asc nulls first, m.created_at asc, m.id asc);

    -- Hold the campaign for the whole pass with the existing pause gate: the
    -- sender re-pauses any due queued row of a paused campaign, so no row can
    -- send on its old time while the new cadence is being written. The
    -- previous status comes back on the final batch.
    update public.campaign_queue_ops o
    set prior_campaign_status = c.status
    from public.campaigns c
    where o.id = v_op and c.id = p_campaign_id;
    update public.campaigns c
    set status = 'paused', updated_at = v_now
    where c.id = p_campaign_id and c.status <> 'archived';
  elsif v_claim = 'inherit' then
    -- Keep the abandoned pass's order; re-time every row from now at this
    -- pace and re-apply all of them (rows it already queued are re-held).
    update public.campaign_queue_plan p
    set scheduled_for = v_start_at + (p.seq::double precision * make_interval(secs => p_pace_seconds)),
        applied = false
    where p.op_id = v_op;
  end if;

  -- Phase 1: hold planned rows still queued on their old time.
  with batch as (
    select p.message_id
    from public.campaign_queue_plan p
    join public.messages m on m.id = p.message_id
    where p.op_id = v_op
      and not p.applied
      and m.status = 'queued'
    order by p.seq
    limit coalesce(p_limit, 2147483647)
    for update of m
  ),
  held as (
    update public.messages m
    set status = 'paused',
        scheduled_for = null,
        metadata = coalesce(m.metadata, '{}'::jsonb) || jsonb_build_object(
          'campaignPause',
          jsonb_build_object(
            'pausedAt', v_now,
            'previousScheduledFor', m.scheduled_for,
            'reason', 'cadence_change'
          )
        )
    from batch
    where m.id = batch.message_id
    returning 1
  )
  select count(*) into v_held from held;

  -- Phase 2 (once nothing is left to hold; same call for unbounded legacy
  -- callers): release planned rows at their planned time. Rows the sender
  -- re-paused get their slot back.
  if v_held = 0 or p_limit is null then
    -- Rows enqueued while the pass held the campaign are inserted 'paused'
    -- with no campaignPause record (send.ts queueForLater). Append them to
    -- the end of this cadence so they are released, not stranded.
    insert into public.campaign_queue_plan (op_id, seq, message_id, scheduled_for)
    select
      v_op,
      t.max_seq + (row_number() over w)::integer,
      m.id,
      greatest(t.max_time, v_now) + ((row_number() over w)::double precision * make_interval(secs => p_pace_seconds))
    from public.messages m
    cross join (
      select coalesce(max(p.seq), -1) as max_seq,
             coalesce(max(p.scheduled_for), v_start_at - make_interval(secs => p_pace_seconds)) as max_time
      from public.campaign_queue_plan p
      where p.op_id = v_op
    ) t
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'paused'
      and not (coalesce(m.metadata, '{}'::jsonb) ? 'campaignPause')
      and m.created_at >= (select o.created_at from public.campaign_queue_ops o where o.id = v_op)
      and not exists (
        select 1 from public.campaign_queue_plan p2
        where p2.op_id = v_op and p2.message_id = m.id
      )
    window w as (order by m.created_at asc, m.id asc);

    with batch as (
      select p.seq, p.message_id, p.scheduled_for
      from public.campaign_queue_plan p
      join public.messages m on m.id = p.message_id
      where p.op_id = v_op
        and m.status = 'paused'
      order by p.seq
      limit coalesce(p_limit, 2147483647)
      for update of m
    ),
    updated as (
      update public.messages m
      set status = 'queued',
          scheduled_for = batch.scheduled_for,
          metadata = coalesce(m.metadata, '{}'::jsonb) - 'campaignPause'
      from batch
      where m.id = batch.message_id
        and m.status = 'paused'
      returning m.id, m.scheduled_for
    ),
    marked as (
      update public.campaign_queue_plan p
      set applied = true
      from updated
      where p.op_id = v_op and p.message_id = updated.id
      returning 1
    )
    select
      count(updated.scheduled_for)::bigint,
      min(updated.scheduled_for),
      max(updated.scheduled_for)
    into v_affected_count, v_first_scheduled_for, v_last_scheduled_for
    from updated;
  end if;

  select count(*)::bigint
  into v_remaining
  from public.campaign_queue_plan p
  join public.messages m on m.id = p.message_id
  where p.op_id = v_op
    and ((not p.applied and m.status = 'queued') or m.status = 'paused');

  if v_remaining = 0 then
    select exists (select 1 from public.campaign_queue_plan p where p.op_id = v_op and p.applied)
    into v_ever_applied;
    update public.campaigns c
    set status = case
          when c.status = 'paused' and o.prior_campaign_status is not null then o.prior_campaign_status
          else c.status
        end,
        pace_seconds = case when v_ever_applied then p_pace_seconds else c.pace_seconds end,
        updated_at = clock_timestamp()
    from public.campaign_queue_ops o
    where o.id = v_op
      and c.id = p_campaign_id
      and c.org_id = v_org_id;
    perform public.campaign_queue_finish_op(v_op, 'done');
  end if;

  return query
  select v_affected_count, v_first_scheduled_for, v_last_scheduled_for, v_remaining;
end;
$$;

create function public.pause_campaign_queue(
  p_campaign_id uuid,
  p_operator_confirmed boolean default false,
  p_limit integer default null
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
  v_active uuid;
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

  -- Pause preempts any in-flight resume or cadence operation.
  select o.id into v_active
  from public.campaign_queue_ops o
  where o.campaign_id = p_campaign_id and o.state = 'active';
  if v_active is not null then
    perform public.campaign_queue_finish_op(v_active, 'cancelled');
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
    limit coalesce(p_limit, 2147483647)
    for update of m
  ),
  paused as (
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
  v_start_after_seconds integer := greatest(coalesce(p_start_after_seconds, 300), 0);
  v_now timestamptz := clock_timestamp();
  v_start_at timestamptz := v_now + make_interval(secs => v_start_after_seconds);
  v_affected_count bigint := 0;
  v_first_scheduled_for timestamptz;
  v_last_scheduled_for timestamptz;
  v_remaining bigint := 0;
  v_claim text;
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

  v_claim := public.campaign_queue_claim_op(p_campaign_id, 'resume', v_op, p_pace_seconds);
  if v_claim = 'inherit' then
    -- Re-time from now (same pace, same order) so a late retry never queues
    -- rows in the past; rows the old op already queued are re-applied.
    update public.campaign_queue_plan p
    set scheduled_for = v_start_at + (p.seq::double precision * make_interval(secs => p_pace_seconds)),
        applied = false
    where p.op_id = v_op;
  elsif v_claim = 'new' then
    if exists (
      select 1
      from public.messages m
      where m.campaign_id = p_campaign_id
        and m.org_id = v_org_id
        and m.channel = 'sms'
        and m.direction = 'outbound'
        and m.status = 'queued'
    ) then
      raise exception 'resume_campaign_queue: pause has not finished holding queued messages; pause again, then resume'
        using errcode = '55000';
    end if;

    insert into public.campaign_queue_plan (op_id, seq, message_id, scheduled_for)
    select
      v_op,
      (row_number() over w - 1)::integer,
      m.id,
      v_start_at + ((row_number() over w - 1)::double precision * make_interval(secs => p_pace_seconds))
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.org_id = v_org_id
      and m.channel = 'sms'
      and m.direction = 'outbound'
      and m.status = 'paused'
    window w as (
      order by
        nullif(m.metadata #>> '{campaignPause,previousScheduledFor}', '')::timestamptz asc nulls last,
        m.created_at asc,
        m.id asc
    );
  end if;

  -- Planned rows still paused: never applied, or re-paused by the sender
  -- while this resume was running (they get their planned time back).
  with batch as (
    select p.seq, p.message_id, p.scheduled_for
    from public.campaign_queue_plan p
    join public.messages m on m.id = p.message_id
    where p.op_id = v_op
      and (m.status = 'paused' or (m.status = 'queued' and not p.applied))
    order by p.seq
    limit coalesce(p_limit, 2147483647)
    for update of m
  ),
  updated as (
    update public.messages m
    set status = 'queued',
        scheduled_for = batch.scheduled_for,
        metadata = coalesce(m.metadata, '{}'::jsonb) - 'campaignPause'
    from batch
    where m.id = batch.message_id
      and m.status in ('paused', 'queued')
    returning m.id, m.scheduled_for
  ),
  marked as (
    update public.campaign_queue_plan p
    set applied = true
    from updated
    where p.op_id = v_op and p.message_id = updated.id
    returning 1
  )
  select
    count(updated.scheduled_for)::bigint,
    min(updated.scheduled_for),
    max(updated.scheduled_for)
  into v_affected_count, v_first_scheduled_for, v_last_scheduled_for
  from updated;

  select count(*)::bigint
  into v_remaining
  from public.campaign_queue_plan p
  join public.messages m on m.id = p.message_id
  where p.op_id = v_op
    and (m.status = 'paused' or (m.status = 'queued' and not p.applied));

  if v_remaining = 0 then
    update public.campaigns c
    set status = 'completed',
        pace_seconds = p_pace_seconds,
        updated_at = clock_timestamp()
    where c.id = p_campaign_id
      and c.org_id = v_org_id;
    perform public.campaign_queue_finish_op(v_op, 'done');
  end if;

  return query
  select v_affected_count, v_first_scheduled_for, v_last_scheduled_for, v_remaining;
end;
$$;

revoke all on function public.campaign_queue_claim_op(uuid, text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.campaign_queue_finish_op(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean, integer, uuid) from public, anon, authenticated;
revoke execute on function public.pause_campaign_queue(uuid, boolean, integer) from public, anon, authenticated;
revoke execute on function public.resume_campaign_queue(uuid, integer, integer, boolean, integer, uuid) from public, anon, authenticated;
grant execute on function public.apply_campaign_cadence_reschedule(uuid, integer, integer, boolean, integer, uuid) to service_role;
grant execute on function public.pause_campaign_queue(uuid, boolean, integer) to service_role;
grant execute on function public.resume_campaign_queue(uuid, integer, integer, boolean, integer, uuid) to service_role;

commit;
