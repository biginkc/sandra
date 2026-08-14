-- ============================================================================
-- Sandra Appointments — PR 3: reminder claim + retry RPCs
--
-- Two service-role-only functions:
--   - fn_claim_appointment_reminders(p_limit): the primary 30-minute-window
--     sweep. now() is derived internally so the window [now(), now()+30m]
--     (both bounds) is fixed inside the function, not supplied by (and
--     therefore not spoofable by) the caller — only the claim SIZE is a
--     caller param. Single statement, chained writable CTEs: locks up to
--     `p_limit` open, unclaimed appointments due in the window (FOR UPDATE
--     SKIP LOCKED, active-assignee-membership gated, oldest due_at first),
--     stamps reminder_claimed_at, then inserts one task_reminder_deliveries
--     row per enabled channel (bell always; slack when the assignee's slack
--     pref is enabled; sms when sms_reminder is enabled AND a
--     reminder_phone is on file) with ON CONFLICT DO NOTHING against the
--     (task_id, channel) unique constraint (20260814150000). Returns the
--     freshly-inserted delivery rows joined with task + assignee context so
--     the sweep route can deliver without a second round trip.
--
--     Codex round 3 (finding 1): `p_limit` was added because the original
--     no-arg version claimed EVERY appointment due in the window in one
--     unbounded call — stamping reminder_claimed_at (never revisited by
--     this function again) and inserting leased delivery rows for all of
--     them regardless of whether the sweep route had budget left to
--     process them. A burst of many appointments due in the same window
--     could out-claim the route's 45s budget, leaving delivery rows sitting
--     leased-but-pending until the retry claim's 10-minute stale-pending
--     threshold picked them up — nothing lost, but ownership was taken well
--     before the worker was actually about to act on it. Mirroring
--     calendar-mutation-sweep's solved pattern: the route now calls this
--     with p_limit=1 in a budget-checked loop, one appointment at a time,
--     so a claim only happens immediately before that appointment's
--     deliveries are attempted — an appointment the budget runs out before
--     reaching is simply left UNCLAIMED (reminder_claimed_at still null)
--     for the next sweep, which starts within 5 minutes, comfortably inside
--     the 30-minute window.
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
-- 0. task_reminder_deliveries — retry-claim lease + fencing columns, and a
--    terminal 'suppressed' status (Codex round 1)
--
-- Same lease/fencing model as task_calendar_mutations
-- (20260814170000:275-316, round 6/7): next_attempt_at is the claim lease
-- (NULL or <= now() = eligible; the claim sets it to now()+2min so a
-- same-sweep or concurrent claim can't see the row again until the lease
-- expires), claim_token is the fencing token (a fresh uuid every claim; the
-- worker's completion write is scoped WHERE id=<mine> AND
-- claim_token=<mine> AND status=<the status this worker was handed>, so a
-- stalled worker whose lease was reclaimed writes zero rows instead of
-- clobbering the new owner). 'suppressed' is the terminal status
-- fn_claim_reminder_retries transitions a retry candidate to when its
-- revalidation (active membership / channel still enabled / appointment
-- still open with due_at within a 15-minute grace of due, per Codex round
-- 3 finding 1) fails — the delivery is never retried again (out of the
-- failed/pending eligibility window) and never silently sent.
-- ----------------------------------------------------------------------------
alter table public.task_reminder_deliveries
  add column claim_token uuid,
  add column next_attempt_at timestamptz;

comment on column public.task_reminder_deliveries.claim_token is
  'Fencing token (Codex round 1, same model as task_calendar_mutations). fn_claim_reminder_retries mints a fresh uuid on every claim of a still-valid row; the worker''s markDelivery write is scoped WHERE id=<mine> AND claim_token=<mine> AND status=<the status handed to the worker>, so a stalled worker whose lease expired and was reclaimed writes zero rows instead of clobbering the new claim. NULL for rows never claimed by the retry sweep (fresh rows from fn_claim_appointment_reminders need no lease — ON CONFLICT DO NOTHING already gives that insert exactly-once ownership).';

comment on column public.task_reminder_deliveries.next_attempt_at is
  'Claim lease / retry-backoff stamp (Codex round 1). NULL or <= now() means eligible for fn_claim_reminder_retries to claim; the claim sets it to now()+2 minutes on every still-valid claim so a concurrent/same-sweep reclaim is impossible within the lease.';

alter table public.task_reminder_deliveries
  drop constraint task_reminder_deliveries_status_check;
alter table public.task_reminder_deliveries
  add constraint task_reminder_deliveries_status_check
  check (status in ('pending', 'sent', 'failed', 'suppressed'));

comment on constraint task_reminder_deliveries_status_check on public.task_reminder_deliveries is
  'suppressed (Codex round 1) is terminal: fn_claim_reminder_retries lands a retry candidate here when its revalidation fails (assignee suspended, channel disabled, or the appointment closed/passed its due_at since the original claim) instead of delivering a now-stale reminder.';

-- ----------------------------------------------------------------------------
-- 1. fn_claim_appointment_reminders — primary window claim
-- ----------------------------------------------------------------------------
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
    limit greatest(p_limit, 0)
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
    ch.reminder_phone as assignee_reminder_phone
  from inserted i
  join channels ch on ch.task_id = i.task_id and ch.channel = i.channel;
end;
$$;

comment on function public.fn_claim_appointment_reminders(integer) is
  'Service-role-only reminder sweep. Derives now() internally (window [now(), now()+30m], both bounds — no late reminders for overdue appointments); FOR UPDATE SKIP LOCKED over open, unclaimed appointments whose assignee has active org membership, oldest due_at first, capped at p_limit (Codex round 3, finding 1 — callers claim one appointment at a time inside a budget loop, same pattern as fn_claim_calendar_mutations, so an appointment the sweep has no budget left to process is simply never claimed rather than claimed-but-undelivered); stamps reminder_claimed_at (via the sandra.allow_appointment_time_move flag, set_config transaction-local) and inserts one task_reminder_deliveries row per enabled channel (bell always, slack/sms per prefs) with ON CONFLICT DO NOTHING, minting a fresh claim_token and a 2-minute lease (next_attempt_at) on every inserted row (Codex round 2) — same fencing model as fn_claim_reminder_retries, from the first attempt. Returns the freshly-inserted delivery rows (claim_token + claimed_status=pending included) joined with task+assignee context.';

revoke all on function public.fn_claim_appointment_reminders(integer) from public, anon, authenticated;
grant execute on function public.fn_claim_appointment_reminders(integer) to service_role;

-- ----------------------------------------------------------------------------
-- 2. fn_claim_reminder_retries — atomic claim + lease/fencing + revalidation
--    (Codex round 1 rewrite — was a read-only SELECT with none of the
--    three properties below; see PR review findings 2/3)
--
-- Three things this version adds over the original read-only SELECT:
--
--   1. Atomic claim, not a bare read. UPDATE ... FROM (SELECT ... FOR
--      UPDATE SKIP LOCKED) over the eligible rows — same idiom as
--      fn_claim_calendar_mutations (20260814210000). attempts<3 now
--      gates BOTH the failed branch AND the previously-uncapped
--      stale-pending branch, so a delivery that keeps crashing before
--      ever reaching a mark-sent/mark-failed write cannot be reclaimed
--      forever. The still-valid branch bumps attempts (this claim IS the
--      next attempt), sets a fresh claim_token, and leases the row via
--      next_attempt_at = now()+2min — a concurrent or same-sweep claim
--      can no longer see it until the lease expires, closing the
--      unbounded-duplicate-SMS/Slack-send hole.
--   2. Revalidation inside the SAME locked selection (finding 3): assignee
--      still has ACTIVE org membership, the channel is still enabled
--      (bell is always fine; slack checks the slack pref; sms checks
--      sms_reminder enabled AND a phone still on file), and the
--      appointment is still open with due_at still within a 15-minute
--      GRACE window past the original due time (Codex round 3, finding 1's
--      compounding hazard — see below). A row that fails ANY of these is
--      transitioned to the terminal 'suppressed' status (with last_error
--      recording why) instead of being handed to the worker for delivery
--      or left to be reclaimed forever.
--
--      Grace window rationale: fn_claim_appointment_reminders (Codex round
--      3, finding 1) now claims one appointment at a time inside a
--      budget-checked loop, so a near-due appointment can be claimed with
--      only seconds left before due_at. If that delivery isn't processed
--      before the sweep's budget runs out, it sits status='pending' and
--      isn't retry-eligible until the stale-pending threshold
--      (created_at < now() - 10 minutes) — by which point the strict
--      `due_at > now()` check this revalidation used to run would ALREADY
--      be false, suppressing a delivery that was claimed on time and
--      simply hadn't been sent yet. That's a real compounding hazard: the
--      very mechanism that makes overflow claims cheap (claim right before
--      processing) would otherwise turn every near-due overflow into a
--      guaranteed suppression at the very next retry pass. 15 minutes
--      covers the worst case (claimed the instant due_at arrives, first
--      retry-eligible 10 minutes later) with headroom for sweep-interval
--      jitter, while still bounding how late a reminder can ever go out.
--   3. Fencing metadata returned to the caller: claim_token (the fresh
--      token this claim minted) and claimed_status (the row's status as
--      of just before this claim — 'pending' or 'failed', unchanged by a
--      still-valid claim) so the worker's completion write can be scoped
--      WHERE id=<mine> AND claim_token=<mine> AND status=<claimed_status>
--      with one-row verification, the same fencing contract as
--      task_calendar_mutations.
--
-- Only still-valid rows are returned — a suppressed row is written but
-- never handed to the worker.
-- ----------------------------------------------------------------------------
create or replace function public.fn_claim_reminder_retries(p_limit integer default 50)
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
  -- Codex round 4 (finding 3): non-null on a row whose PREVIOUS attempt
  -- already reached the provider (Slack/SMS returned a message id) before
  -- crashing on its own mark-sent write — the worker must reconcile
  -- (mark sent using this id) instead of re-sending. Null for a row whose
  -- provider call never completed (a genuine failed/stuck-pending row) or
  -- for bell (which never sets it; dedupe is the notifications unique
  -- index instead).
  provider_message_id text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select d.id, d.task_id, d.org_id, d.channel, d.attempts, d.status
    from public.task_reminder_deliveries d
    where (
        (d.status = 'failed' and d.attempts < 3)
        or (d.status = 'pending' and d.attempts < 3 and d.created_at < now() - interval '10 minutes')
      )
      and (d.next_attempt_at is null or d.next_attempt_at <= now())
    order by d.created_at
    for update skip locked
    limit greatest(p_limit, 0)
  ),
  revalidated as (
    select
      c.id, c.task_id, c.org_id, c.channel, c.attempts, c.status,
      t.status as task_status, t.due_at, t.end_at, t.title, t.assignee_id,
      exists (
        select 1
        from public.memberships m
        where m.user_id = t.assignee_id
          and m.org_id = c.org_id
          and m.access_status = 'active'
          and m.deletion_prepared_at is null
          and (m.access_expires_at is null or m.access_expires_at > now())
      ) as assignee_active,
      case c.channel
        when 'bell' then true
        when 'slack' then coalesce(
          (
            select uip.enabled from public.user_integration_prefs uip
            where uip.user_id = t.assignee_id and uip.channel = 'slack'
          ),
          false
        )
        when 'sms' then coalesce(
          (
            select uip.enabled and uip.reminder_phone is not null
            from public.user_integration_prefs uip
            where uip.user_id = t.assignee_id and uip.channel = 'sms_reminder'
          ),
          false
        )
        else false
      end as channel_still_enabled,
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
    from candidates c
    join public.tasks t on t.id = c.task_id
  ),
  eligible as (
    select
      r.*,
      (
        r.assignee_active
        and r.task_status = 'open'
        -- Codex round 3 (finding 1): 15-minute grace past due_at, not a
        -- strict `> now()` — see the function-level comment above for why
        -- a bare due_at check would suppress an overflow row the very
        -- first time it's retried.
        and r.due_at > now() - interval '15 minutes'
        and r.channel_still_enabled
      ) as still_valid
    from revalidated r
  ),
  claimed as (
    update public.task_reminder_deliveries d
    set
      attempts = case when e.still_valid then d.attempts + 1 else d.attempts end,
      claim_token = case when e.still_valid then gen_random_uuid() else d.claim_token end,
      next_attempt_at = case when e.still_valid then now() + interval '2 minutes' else d.next_attempt_at end,
      status = case when e.still_valid then d.status else 'suppressed' end,
      last_error = case
        when e.still_valid then d.last_error
        else 'retry_suppressed: ' || (
          case
            when not e.assignee_active then 'assignee_inactive'
            when e.task_status <> 'open' then 'appointment_not_open'
            -- Codex round 3 (finding 1): matches still_valid's grace window
            -- above — a due_at within the last 15 minutes is NOT this
            -- branch (still_valid would be true), so reaching here means
            -- due_at is genuinely more than 15 minutes stale.
            when e.due_at <= now() - interval '15 minutes' then 'appointment_due_passed'
            else 'channel_disabled'
          end
        )
      end
    from eligible e
    where d.id = e.id
    returning
      d.id, d.task_id, d.org_id, d.channel, d.attempts, d.claim_token, d.status,
      d.provider_message_id,
      e.title, e.due_at, e.end_at, e.assignee_id, e.assignee_timezone, e.assignee_reminder_phone,
      e.still_valid
  )
  select
    c.id as delivery_id, c.task_id, c.org_id, c.channel, c.attempts, c.claim_token,
    c.status as claimed_status,
    c.title as task_title, c.due_at as task_due_at, c.end_at as task_end_at,
    c.assignee_id, c.assignee_timezone, c.assignee_reminder_phone, c.provider_message_id
  from claimed c
  where c.still_valid;
$$;

comment on function public.fn_claim_reminder_retries(integer) is
  'Service-role-only atomic retry claim (Codex round 1 rewrite). UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED) over task_reminder_deliveries WHERE (status=failed OR status=pending-stale-10min) AND attempts<3 AND lease-eligible; still-valid rows get attempts+1, a fresh claim_token, and a 2-minute lease (next_attempt_at) — same fencing model as task_calendar_mutations. Inside the SAME locked selection, re-validates assignee active membership, channel still enabled, and appointment still open with due_at still within a 15-minute grace past due (Codex round 3, finding 1 — widened from a strict due_at>now() so a near-due appointment claimed by fn_claim_appointment_reminders''s one-at-a-time overflow behavior is not suppressed by its own first retry pass); a row failing any check is transitioned to terminal status=suppressed (last_error records why) and is NOT returned. Returns claim_token + claimed_status (pre-claim status) so the worker''s completion write can be scoped WHERE id=<mine> AND claim_token=<mine> AND status=<claimed_status> with one-row verification. Also returns provider_message_id (Codex round 4, finding 3) — non-null means a PRIOR attempt already reached the provider (Slack/SMS) and only crashed on its own mark-sent write; the worker reconciles (marks sent using this id) instead of re-sending, since Slack/SMS have no send-side idempotency key to make a re-send itself safe.';

revoke all on function public.fn_claim_reminder_retries(integer) from public, anon, authenticated;
grant execute on function public.fn_claim_reminder_retries(integer) to service_role;

commit;
