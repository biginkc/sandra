-- Fix: fn_claim_appointment_reminders crashed on EVERY invocation with
-- `column reference "task_id" is ambiguous`. The RETURNS TABLE
-- out-parameters (task_id, org_id, channel, attempts, ...) are plpgsql
-- variables in scope throughout the body, so the claim CTEs' unqualified
-- column references (e.g. `select task_id, org_id, ... from prefs`) were
-- ambiguous under plpgsql's default variable_conflict=error. Nothing in the
-- body reads an out-parameter as a variable (rows are produced only by the
-- final RETURN QUERY select), so `#variable_conflict use_column` is exactly
-- the intended resolution; the body is otherwise byte-identical to
-- 20260814200000. fn_claim_reminder_retries is LANGUAGE SQL (columns take
-- precedence over parameters there) and fully alias-qualified — unaffected.
--
-- Caught by the first real sweep in production (reportError surface
-- cron_appointment_reminder_sweep); reproduced by the companion suite
-- 20260814200000_appointment_reminders.integration.test.ts (27 failures).
-- plpgsql bodies parse lazily at first execution, so DDL-only migration
-- rehearsal could not surface it.

begin;

create or replace function public.fn_claim_appointment_reminders(p_limit integer default 1)
returns table (
  delivery_id uuid,
  task_id uuid,
  org_id uuid,
  channel text,
  attempts integer,
  claim_token uuid,
  claimed_status text,
  task_title text,
  task_due_at timestamptz,
  task_end_at timestamptz,
  assignee_id uuid,
  assignee_timezone text,
  assignee_reminder_phone text,
  -- Codex round 11 (finding 2): threaded through so the delivery worker
  -- can build a linkage-aware CTA deep link (property -> /leads/<id>,
  -- contact-only -> /messages?thread=<contactId>, personal block ->
  -- /dashboard) instead of the dead /tasks/<id> route. Exactly one of the
  -- two (or neither) is ever set, same contract as tasks.related_property_id
  -- / tasks.contact_id themselves.
  related_property_id uuid,
  contact_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
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
    limit greatest(p_limit, 0)
  ),
  claimed as (
    update public.tasks t
    set reminder_claimed_at = v_now
    from locked
    where t.id = locked.id
    returning t.id, t.org_id, t.assignee_id, t.title, t.due_at, t.end_at,
      t.related_property_id, t.contact_id
  ),
  -- One row per claimed appointment, aggregating that assignee's channel
  -- prefs. bool_or(... and uip.enabled) is false (not null) when the
  -- assignee has no prefs row at all — fail-closed for slack the same way
  -- loadIntegrationPrefs defaults it, and fail-closed for sms per the
  -- explicit R2-5 contract (absent row = disabled).
  prefs as (
    select
      c.id as task_id, c.org_id, c.assignee_id, c.title, c.due_at, c.end_at,
      c.related_property_id, c.contact_id,
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
    group by c.id, c.org_id, c.assignee_id, c.title, c.due_at, c.end_at,
      c.related_property_id, c.contact_id
  ),
  channels as (
    select task_id, org_id, assignee_id, title, due_at, end_at, timezone, reminder_phone,
           related_property_id, contact_id, 'bell'::text as channel
    from prefs
    union all
    select task_id, org_id, assignee_id, title, due_at, end_at, timezone, reminder_phone,
           related_property_id, contact_id, 'slack'::text
    from prefs
    where slack_enabled
    union all
    select task_id, org_id, assignee_id, title, due_at, end_at, timezone, reminder_phone,
           related_property_id, contact_id, 'sms'::text
    from prefs
    where sms_enabled
  ),
  inserted as (
    -- Codex round 2 fix: mint the same claim_token + 2-minute lease
    -- (next_attempt_at) on the INITIAL claim that fn_claim_reminder_retries
    -- already mints on a reclaim. Before this, a fresh row here carried a
    -- NULL claim_token, so its own sent/failed write was scoped only by
    -- delivery id — a slow initial SMS/Slack call could outlive nothing
    -- (no lease existed to outlive), get reclaimed by the stale-pending
    -- retry path once >10min passed, and then both workers would write the
    -- same row's outcome with no fencing between them. Every delivery now
    -- starts leased/tokened, so the initial and retry paths share one
    -- fencing contract from the first attempt.
    insert into public.task_reminder_deliveries (org_id, task_id, channel, claim_token, next_attempt_at)
    select org_id, task_id, channel, gen_random_uuid(), v_now + interval '2 minutes' from channels
    on conflict (task_id, channel) do nothing
    returning id, task_id, org_id, channel, attempts, claim_token, status
  )
  select
    i.id as delivery_id,
    i.task_id,
    i.org_id,
    i.channel,
    i.attempts,
    i.claim_token,
    i.status as claimed_status,
    ch.title as task_title,
    ch.due_at as task_due_at,
    ch.end_at as task_end_at,
    ch.assignee_id,
    coalesce(ch.timezone, 'America/Chicago') as assignee_timezone,
    ch.reminder_phone as assignee_reminder_phone,
    ch.related_property_id,
    ch.contact_id
  from inserted i
  join channels ch on ch.task_id = i.task_id and ch.channel = i.channel;
end;
$$;

commit;
