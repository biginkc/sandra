-- ============================================================================
-- Sandra Appointments — PR 3: reminder claim + retry RPCs
--
-- Two service-role-only functions:
--   - fn_claim_appointment_reminders(): the primary 30-minute-window sweep.
--     Takes NO time params — now() is derived internally so the window
--     [now(), now()+30m] (both bounds) is fixed inside the function, not
--     supplied by (and therefore not spoofable by) the caller. Single
--     statement, chained writable CTEs: locks open, unclaimed appointments
--     due in the window (FOR UPDATE SKIP LOCKED, active-assignee-membership
--     gated), stamps reminder_claimed_at, then inserts one
--     task_reminder_deliveries row per enabled channel (bell always; slack
--     when the assignee's slack pref is enabled; sms when sms_reminder is
--     enabled AND a reminder_phone is on file) with ON CONFLICT DO NOTHING
--     against the (task_id, channel) unique constraint (20260814150000).
--     Returns the freshly-inserted delivery rows joined with task +
--     assignee context so the sweep route can deliver without a second
--     round trip.
--   - fn_claim_reminder_retries(p_limit): the crash-safety complement.
--     Reads task_reminder_deliveries directly for rows that need another
--     attempt — status='failed' AND attempts<3, OR status='pending' older
--     than 10 minutes (a sweep that claimed a delivery row and crashed
--     before marking it). Read-only select, no lock held past the call
--     (same at-least-once posture documented in the plan for slack/sms —
--     bell's own exactly-once guarantee comes from the notifications
--     partial unique index, not from anything here).
--
-- Both functions set `sandra.allow_appointment_time_move` transaction-
-- locally (via set_config(..., true) — local to the function's own
-- implicit transaction) before touching `tasks.reminder_claimed_at`: that
-- column is one of the lifecycle-owned facets the 20260814150000 tenant-
-- integrity trigger guards (`tasks_tenant_integrity_guard`, "Lifecycle
-- state is lifecycle-owned end to end" — reminder_claimed_at is
-- specifically named there), so an UPDATE against it fails closed without
-- the flag.
--
-- Full plan: reactive-puzzling-crane.md v9, PR 3 section ("Atomic claim
-- RPC (R2-3, R3-2)" + "Delivery semantics").
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. fn_claim_appointment_reminders — primary window claim
-- ----------------------------------------------------------------------------
create or replace function public.fn_claim_appointment_reminders()
returns table (
  delivery_id uuid,
  task_id uuid,
  org_id uuid,
  channel text,
  attempts integer,
  task_title text,
  task_due_at timestamptz,
  task_end_at timestamptz,
  assignee_id uuid,
  assignee_timezone text,
  assignee_reminder_phone text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
begin
  -- Local to this function's own implicit transaction (is_local=true) —
  -- never leaks to any other statement. Required before the reminder_claimed_at
  -- UPDATE below; see the module comment.
  perform set_config('sandra.allow_appointment_time_move', 'on', true);

  return query
  with locked as (
    select t.id
    from public.tasks t
    where t.type = 'appointment'
      and t.status = 'open'
      and t.reminder_claimed_at is null
      -- Both bounds fixed inside the function: an appointment whose due_at
      -- has already passed is NOT claimed here — no late 30-min reminders
      -- for overdue appointments (plan R2-3).
      and t.due_at >= v_now
      and t.due_at <= v_now + interval '30 minutes'
      -- Inactive-assignee tasks are tolerated (never blocked from
      -- existing) but skipped by the claim, same predicates as
      -- tasks_tenant_integrity_guard / hasActiveSandraAccess.
      and exists (
        select 1
        from public.memberships m
        where m.user_id = t.assignee_id
          and m.org_id = t.org_id
          and m.access_status = 'active'
          and m.deletion_prepared_at is null
          and (m.access_expires_at is null or m.access_expires_at > v_now)
      )
    order by t.due_at
    for update skip locked
  ),
  claimed as (
    update public.tasks t
    set reminder_claimed_at = v_now
    from locked
    where t.id = locked.id
    returning t.id, t.org_id, t.assignee_id, t.title, t.due_at, t.end_at
  ),
  -- One row per claimed appointment, aggregating that assignee's channel
  -- prefs. bool_or(... and uip.enabled) is false (not null) when the
  -- assignee has no prefs row at all — fail-closed for slack the same way
  -- loadIntegrationPrefs defaults it, and fail-closed for sms per the
  -- explicit R2-5 contract (absent row = disabled).
  prefs as (
    select
      c.id as task_id, c.org_id, c.assignee_id, c.title, c.due_at, c.end_at,
      coalesce(bool_or(uip.channel = 'slack' and uip.enabled), false) as slack_enabled,
      coalesce(
        bool_or(uip.channel = 'sms_reminder' and uip.enabled and uip.reminder_phone is not null),
        false
      ) as sms_enabled,
      max(uip.reminder_phone) filter (where uip.channel = 'sms_reminder') as reminder_phone,
      -- Same tie-break as fn_get_member_timezone: prefer google_calendar's
      -- copy of the (per-user, replicated-per-channel) timezone value.
      coalesce(
        max(uip.timezone) filter (where uip.channel = 'google_calendar'),
        max(uip.timezone)
      ) as timezone
    from claimed c
    left join public.user_integration_prefs uip on uip.user_id = c.assignee_id
    group by c.id, c.org_id, c.assignee_id, c.title, c.due_at, c.end_at
  ),
  channels as (
    select task_id, org_id, assignee_id, title, due_at, end_at, timezone, reminder_phone,
           'bell'::text as channel
    from prefs
    union all
    select task_id, org_id, assignee_id, title, due_at, end_at, timezone, reminder_phone,
           'slack'::text
    from prefs
    where slack_enabled
    union all
    select task_id, org_id, assignee_id, title, due_at, end_at, timezone, reminder_phone,
           'sms'::text
    from prefs
    where sms_enabled
  ),
  inserted as (
    insert into public.task_reminder_deliveries (org_id, task_id, channel)
    select org_id, task_id, channel from channels
    on conflict (task_id, channel) do nothing
    returning id, task_id, org_id, channel, attempts
  )
  select
    i.id as delivery_id,
    i.task_id,
    i.org_id,
    i.channel,
    i.attempts,
    ch.title as task_title,
    ch.due_at as task_due_at,
    ch.end_at as task_end_at,
    ch.assignee_id,
    coalesce(ch.timezone, 'America/Chicago') as assignee_timezone,
    ch.reminder_phone as assignee_reminder_phone
  from inserted i
  join channels ch on ch.task_id = i.task_id and ch.channel = i.channel;
end;
$$;

comment on function public.fn_claim_appointment_reminders() is
  'Service-role-only reminder sweep. Derives now() internally (window [now(), now()+30m], both bounds — no late reminders for overdue appointments); FOR UPDATE SKIP LOCKED over open, unclaimed appointments whose assignee has active org membership; stamps reminder_claimed_at (via the sandra.allow_appointment_time_move flag, set_config transaction-local) and inserts one task_reminder_deliveries row per enabled channel (bell always, slack/sms per prefs) with ON CONFLICT DO NOTHING. Returns the freshly-inserted delivery rows joined with task+assignee context.';

revoke all on function public.fn_claim_appointment_reminders() from public, anon, authenticated;
grant execute on function public.fn_claim_appointment_reminders() to service_role;

-- ----------------------------------------------------------------------------
-- 2. fn_claim_reminder_retries — crash-safety complement
--
-- Read-only: no lock survives past this call (a plain RPC's implicit
-- transaction ends when the function returns), so this is intentionally
-- an at-least-once hand-off, same posture the plan documents for
-- slack/sms delivery generally. Bounded by the delivery row's own
-- attempts<3 cap plus the app-layer mark-sent/mark-failed write after
-- each attempt, so duplicate work here is rare and self-limiting rather
-- than open-ended.
-- ----------------------------------------------------------------------------
create or replace function public.fn_claim_reminder_retries(p_limit integer default 50)
returns table (
  delivery_id uuid,
  task_id uuid,
  org_id uuid,
  channel text,
  attempts integer,
  task_title text,
  task_due_at timestamptz,
  task_end_at timestamptz,
  assignee_id uuid,
  assignee_timezone text,
  assignee_reminder_phone text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with stale as (
    select d.id, d.task_id, d.org_id, d.channel, d.attempts
    from public.task_reminder_deliveries d
    join public.tasks t on t.id = d.task_id
    -- A cancelled/completed appointment's outstanding reminder work is
    -- moot — no point retrying a notification for an appointment that no
    -- longer needs one.
    where t.status = 'open'
      and (
        (d.status = 'failed' and d.attempts < 3)
        or (d.status = 'pending' and d.created_at < now() - interval '10 minutes')
      )
    order by d.created_at
    limit greatest(p_limit, 0)
  )
  select
    s.id as delivery_id, s.task_id, s.org_id, s.channel, s.attempts,
    t.title as task_title, t.due_at as task_due_at, t.end_at as task_end_at,
    t.assignee_id,
    coalesce(
      (
        select uip.timezone from public.user_integration_prefs uip
        where uip.user_id = t.assignee_id and uip.channel = 'google_calendar'
        limit 1
      ),
      (
        select uip.timezone from public.user_integration_prefs uip
        where uip.user_id = t.assignee_id
        limit 1
      ),
      'America/Chicago'
    ) as assignee_timezone,
    (
      select uip.reminder_phone from public.user_integration_prefs uip
      where uip.user_id = t.assignee_id and uip.channel = 'sms_reminder'
      limit 1
    ) as assignee_reminder_phone
  from stale s
  join public.tasks t on t.id = s.task_id;
$$;

comment on function public.fn_claim_reminder_retries(integer) is
  'Service-role-only retry selection for the reminder sweep: task_reminder_deliveries rows with status=failed AND attempts<3, or status=pending older than 10 minutes (a sweep that crashed mid-delivery). Read-only — no lock survives past the call, same at-least-once posture as the rest of the slack/sms delivery path. Skips deliveries for appointments no longer open.';

revoke all on function public.fn_claim_reminder_retries(integer) from public, anon, authenticated;
grant execute on function public.fn_claim_reminder_retries(integer) to service_role;

commit;
