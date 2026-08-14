-- ============================================================================
-- Sandra Appointments — PR 2: booking RPCs
--
-- Two callable functions:
--   - fn_get_member_timezone(p_user): lets a member look up a TEAMMATE's
--     timezone (needed to render "3:00 PM Central" on the booking form for
--     whoever it's being booked for) despite `user_integration_prefs` RLS
--     being self-only (061:30 + hardening).
--   - fn_book_appointment(...): one transaction that creates the appointment
--     task, opens its calendar-mutation ledger row, and (property bookings
--     only) promotes prospect->lead and sets the thread dispo.
--
-- Full plan: reactive-puzzling-crane.md v9, PR 2 section + "PR-1
-- implementation deviations" block.
--
-- ----------------------------------------------------------------------------
-- Deviation from the plan text (documented for Codex review)
-- ----------------------------------------------------------------------------
-- 1. SECURITY DEFINER, not SECURITY INVOKER. The plan (written before the
--    PR-1 review hardening) says fn_book_appointment is SECURITY INVOKER.
--    PR 1 made task_calendar_mutations server-owned — INSERT is REVOKEd
--    from anon/authenticated (20260814150000:610-611) — so an invoker-rights
--    version could never write its own ledger row; the booking transaction
--    would fail on the second INSERT for every authenticated caller. This
--    function is SECURITY DEFINER with a pinned search_path and does its
--    OWN explicit auth/membership checks (actor derived from auth.uid(),
--    active-membership checks on both actor and assignee) rather than
--    relying on RLS, so it is not a privilege-escalation surface despite
--    running as the function owner.
-- 2. Parameter order. The plan's literal signature interleaves two
--    DEFAULT NULL params (p_contact, p_property) before a required param
--    (p_title) — Postgres requires every parameter after the first
--    DEFAULT to also have a default, so that order does not compile.
--    Below, p_title moves up next to the other required params; every
--    parameter keeps its plan-specified name, and the test file (and any
--    future caller) invokes this function with named arguments
--    (`p_org => ...`) so call sites are order-independent regardless.
-- 3. Booking idempotency (Codex round 1). fn_book_appointment gains a
--    trailing `p_idempotency_key uuid default null`. The popover mints one
--    key per open and resubmits it on retry, so a network hiccup after the
--    server committed but before the client saw the response can't create
--    a second appointment. `tasks.booking_idempotency_key` is unique per
--    (org_id, key) via a partial index (NULLs — the overwhelming majority
--    of rows, every non-idempotent-caller booking — are excluded, same
--    pattern as the calendar-chain serialization index). The signature
--    change means CREATE OR REPLACE would create a 10-arg overload
--    alongside the old 9-arg function rather than replacing it, so the old
--    signature is explicitly DROPped first.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. Booking idempotency — schema
--
-- booking_idempotency_key is nullable (only idempotent callers set it),
-- appointment-only (CHECK — a personal/custom task type has no booking
-- flow to be idempotent over), and unique per org when present (partial
-- unique index — a NULL key never conflicts with another NULL key, so
-- every ordinary caller is unaffected).
-- ----------------------------------------------------------------------------
alter table public.tasks
  add column booking_idempotency_key uuid;

alter table public.tasks
  add constraint tasks_booking_idempotency_key_appointment_check
  check (booking_idempotency_key is null or type = 'appointment');

create unique index idx_tasks_org_booking_idempotency_key
  on public.tasks (org_id, booking_idempotency_key)
  where booking_idempotency_key is not null;

-- ----------------------------------------------------------------------------
-- 0a. tasks_tenant_integrity_guard — extended for booking_idempotency_key
--
-- CREATE OR REPLACE of the trigger function defined in the already-merged
-- 20260814150000 migration (that file is not edited here). Full body
-- copied verbatim from that migration except for one added disjunct in the
-- lifecycle-state UPDATE branch: booking_idempotency_key joins the set of
-- appointment-owned facets that are immutable outside the lifecycle flag,
-- for the same reason status/outcome/calendar_generation/etc. are — a bare
-- UPDATE could otherwise strip or forge the idempotency key post-creation,
-- and PR 3's lifecycle RPCs never need to touch it (it is set once, at
-- booking time, by fn_book_appointment itself).
-- ----------------------------------------------------------------------------
create or replace function public.tasks_tenant_integrity_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- OLD is unassigned in INSERT triggers and plpgsql does not guarantee
  -- boolean short-circuiting, so every OLD access lives inside the
  -- explicit UPDATE branch below.
  v_org_changed boolean := true;
  v_contact_changed boolean := true;
  v_property_changed boolean := true;
  v_assignee_changed boolean := true;
begin
  if tg_op = 'INSERT' then
    -- Appointments are BORN open and unclaimed: an insert already marked
    -- terminal (with forged completion metadata), reminder-claimed, or
    -- carrying a non-zero calendar generation would satisfy every CHECK
    -- while bypassing the lifecycle RPCs and ledger entirely — the same
    -- trust-boundary hole as direct UPDATE/DELETE, on the creation side.
    -- PR 3's reschedule inserts successors as open rows, so the flag
    -- escape exists for symmetry, not need.
    if new.type = 'appointment'
       and (new.status <> 'open'
            or new.outcome is not null
            or new.reminder_claimed_at is not null
            or new.calendar_generation <> 0
            or new.completed_at is not null
            or new.completed_by is not null
            or new.snoozed_until is not null)
       and coalesce(current_setting('sandra.allow_appointment_time_move', true), '') <> 'on'
    then
      raise exception
        'tasks_tenant_integrity_guard: appointments are created open and unclaimed; lifecycle state comes later'
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- tasks.org_id is immutable: no lifecycle moves a task between
    -- tenants. Property/contact-linked tasks are already anchored by
    -- composite parent FKs, but a personal appointment has no parent —
    -- without this, a dual-org member could carry one (and its calendar
    -- chain) across the tenant boundary with no audit trail.
    if new.org_id is distinct from old.org_id then
      raise exception
        'tasks_tenant_integrity_guard: tasks cannot change org'
        using errcode = 'P0001';
    end if;
    v_org_changed := false;
    v_contact_changed := new.contact_id is distinct from old.contact_id;
    v_property_changed := new.related_property_id is distinct from old.related_property_id;
    v_assignee_changed := new.assignee_id is distinct from old.assignee_id;

    -- Appointment time moves are lifecycle-owned: an authenticated member
    -- updating due_at/end_at directly (or via the legacy snooze path)
    -- would shift Sandra's window without the calendar reschedule
    -- machinery, desyncing the external event. Lifecycle RPCs (PR 3) opt
    -- in with a transaction-local flag; nothing else may move an
    -- appointment's times.
    if old.type = 'appointment'
       and (new.due_at is distinct from old.due_at
            or new.end_at is distinct from old.end_at)
       and coalesce(current_setting('sandra.allow_appointment_time_move', true), '') <> 'on'
    then
      raise exception
        'tasks_tenant_integrity_guard: appointment times move only through the reschedule lifecycle'
        using errcode = 'P0001';
    end if;

    -- Appointment identity is immutable: without this, a member could flip
    -- an appointment to 'custom' (clearing its chain), move due_at while
    -- the time guard is blind, and flip it back — resynchronizing nothing.
    -- Type transitions across the appointment boundary and any
    -- calendar_chain_id change are lifecycle-only operations.
    if ((old.type = 'appointment') <> (new.type = 'appointment')
        or new.calendar_chain_id is distinct from old.calendar_chain_id)
       and coalesce(current_setting('sandra.allow_appointment_time_move', true), '') <> 'on'
    then
      raise exception
        'tasks_tenant_integrity_guard: appointment identity (type/calendar chain) is immutable outside the lifecycle'
        using errcode = 'P0001';
    end if;

    -- Appointment ownership is lifecycle-owned too: a bare assignee swap
    -- would leave the Google event under the old teammate's account with
    -- no ledger record to move it. The reassign RPC (PR 3) deletes the
    -- old-account event and recreates it under the new assignee inside
    -- the flagged transaction.
    if old.type = 'appointment'
       and new.assignee_id is distinct from old.assignee_id
       and coalesce(current_setting('sandra.allow_appointment_time_move', true), '') <> 'on'
    then
      raise exception
        'tasks_tenant_integrity_guard: appointment reassignment goes through the calendar lifecycle'
        using errcode = 'P0001';
    end if;

    -- Lifecycle state is lifecycle-owned end to end: a direct REST write
    -- could otherwise close an appointment (status/outcome), suppress its
    -- reminders (reminder_claimed_at), or fake a calendar version
    -- (calendar_generation) while satisfying every CHECK — bypassing the
    -- ledger exactly like the DELETE case. One flag covers all
    -- appointment-owned facets; PR 3's RPCs (outcome, claim, reschedule,
    -- reassign, cancel) set it transaction-locally. booking_idempotency_key
    -- joins this set (Codex round 1, PR 2): it is written once at booking
    -- time by fn_book_appointment and must never be alterable afterward,
    -- same trust boundary as the rest of this clause.
    if old.type = 'appointment'
       and (new.status is distinct from old.status
            or new.outcome is distinct from old.outcome
            or new.reminder_claimed_at is distinct from old.reminder_claimed_at
            or new.calendar_generation is distinct from old.calendar_generation
            or new.completed_at is distinct from old.completed_at
            or new.completed_by is distinct from old.completed_by
            or new.snoozed_until is distinct from old.snoozed_until
            or new.booking_idempotency_key is distinct from old.booking_idempotency_key)
       and coalesce(current_setting('sandra.allow_appointment_time_move', true), '') <> 'on'
    then
      raise exception
        'tasks_tenant_integrity_guard: appointment lifecycle state changes only through the lifecycle'
        using errcode = 'P0001';
    end if;
  end if;

  -- Each relation validates independently, only when it (or the org)
  -- actually changed. Side-effect UPDATEs stay harmless: the contact FK's
  -- ON DELETE SET NULL changes contact_id on historical tasks whose
  -- assignee may be long-inactive — that write must not drag the assignee
  -- re-check along with it.
  if not (v_org_changed or v_contact_changed or v_property_changed or v_assignee_changed) then
    return new;
  end if;

  if (v_org_changed or v_contact_changed) and new.contact_id is not null then
    if not exists (
      select 1
      from public.contacts c
      where c.id = new.contact_id
        and c.org_id = new.org_id
    ) then
      raise exception
        'tasks_tenant_integrity_guard: contact % is not in org %', new.contact_id, new.org_id
        using errcode = 'P0001';
    end if;
  end if;

  if (v_org_changed or v_property_changed) and new.related_property_id is not null then
    if not exists (
      select 1
      from public.properties p
      where p.id = new.related_property_id
        and p.org_id = new.org_id
    ) then
      raise exception
        'tasks_tenant_integrity_guard: property % is not in org %', new.related_property_id, new.org_id
        using errcode = 'P0001';
    end if;
  end if;

  if v_org_changed or v_assignee_changed then
    -- FOR SHARE serializes this check against concurrent membership
    -- lifecycle UPDATEs (suspension, expiry-stamping): under READ
    -- COMMITTED an unlocked EXISTS could observe the still-active row
    -- while a parallel transaction suspends it, letting both commit. The
    -- share lock makes the suspender wait for this insert/reassign (or
    -- vice versa), so one of the two orders wins cleanly.
    perform 1
    from public.memberships m
    where m.user_id = new.assignee_id
      and m.org_id = new.org_id
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
    for share of m;

    if not found then
      raise exception
        'tasks_tenant_integrity_guard: assignee % has no active membership in org %', new.assignee_id, new.org_id
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 1. fn_uuid_to_base32hex — deterministic Google Calendar event id
--
-- Pure/immutable transform, no table access: encodes a uuid's 128 bits as
-- lowercase base32hex (Google's event-id charset [a-v0-9], RFC 4648 base32
-- extended-hex alphabet, no padding) — 26 characters, well inside Google's
-- 5-1024 length bound. No SECURITY DEFINER needed; it touches no data.
-- ----------------------------------------------------------------------------
create or replace function public.fn_uuid_to_base32hex(p_id uuid)
returns text
language plpgsql
immutable
as $$
declare
  v_alphabet text := '0123456789abcdefghijklmnopqrstuv';
  v_bytes bytea := decode(replace(p_id::text, '-', ''), 'hex');
  v_result text := '';
  v_buffer bigint := 0;
  v_bits_in_buffer integer := 0;
  v_byte integer;
  i integer;
begin
  for i in 0..length(v_bytes) - 1 loop
    v_byte := get_byte(v_bytes, i);
    -- Masked to 32 bits so the buffer never approaches bigint's range even
    -- though old (already-consumed) high bits aren't explicitly cleared;
    -- at most 12 bits are ever live (8 just-added + up to 4 carried over).
    v_buffer := ((v_buffer << 8) | v_byte) & 4294967295;
    v_bits_in_buffer := v_bits_in_buffer + 8;
    while v_bits_in_buffer >= 5 loop
      v_bits_in_buffer := v_bits_in_buffer - 5;
      v_result := v_result || substr(v_alphabet, ((v_buffer >> v_bits_in_buffer) & 31)::integer + 1, 1);
    end loop;
  end loop;

  -- 128 bits is not a multiple of 5; the final partial group (3 real bits)
  -- is left-shifted and zero-padded on the right, per RFC 4648.
  if v_bits_in_buffer > 0 then
    v_result := v_result || substr(
      v_alphabet,
      ((v_buffer << (5 - v_bits_in_buffer)) & 31)::integer + 1,
      1
    );
  end if;

  return v_result;
end;
$$;

comment on function public.fn_uuid_to_base32hex(uuid) is
  'Deterministic uuid -> lowercase base32hex (Google Calendar event-id charset [a-v0-9]). Used to derive client_event_id from a task_calendar_mutations row id so a retried event creation reconciles via 409 instead of duplicating.';

-- ----------------------------------------------------------------------------
-- 2. fn_get_member_timezone — teammate timezone lookup
--
-- "Shared active org": an org where the CALLER has an active membership AND
-- p_user also has an active membership (same lifecycle predicates as
-- hasActiveSandraAccess: access_status='active', deletion_prepared_at null,
-- access_expires_at null-or-future, everywhere). This is stricter than "any
-- org either is in" — a suspended caller gets no visibility into anyone's
-- timezone, and a lookup can't succeed through an org where the TARGET has
-- gone inactive, matching "Raises on no shared active org".
-- ----------------------------------------------------------------------------
create or replace function public.fn_get_member_timezone(p_user uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_shared_org uuid;
  v_timezone text;
begin
  if v_caller is null then
    raise exception 'fn_get_member_timezone: no authenticated caller' using errcode = '28000';
  end if;

  select mc.org_id
  into v_shared_org
  from public.memberships mc
  join public.memberships mt
    on mt.org_id = mc.org_id
   and mt.user_id = p_user
  where mc.user_id = v_caller
    and mc.access_status = 'active'
    and mc.deletion_prepared_at is null
    and (mc.access_expires_at is null or mc.access_expires_at > now())
    and mt.access_status = 'active'
    and mt.deletion_prepared_at is null
    and (mt.access_expires_at is null or mt.access_expires_at > now())
  limit 1;

  if v_shared_org is null then
    raise exception 'fn_get_member_timezone: no shared active org with %', p_user
      using errcode = 'P0001';
  end if;

  -- Any channel row carries the same timezone value (061: one per-user
  -- value, replicated per channel row) — prefer google_calendar when
  -- present, purely for a deterministic pick among ties.
  select uip.timezone
  into v_timezone
  from public.user_integration_prefs uip
  where uip.user_id = p_user
  order by (uip.channel <> 'google_calendar'), uip.channel
  limit 1;

  return coalesce(v_timezone, 'America/Chicago');
end;
$$;

comment on function public.fn_get_member_timezone(uuid) is
  'Teammate timezone lookup for the booking form. Verifies caller and target share an org where BOTH have active membership (hasActiveSandraAccess predicates); user_integration_prefs RLS is self-only, so this is the only path to a teammate timezone. Fallback America/Chicago.';

revoke all on function public.fn_get_member_timezone(uuid) from public, anon;
grant execute on function public.fn_get_member_timezone(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. fn_book_appointment — atomic booking transaction
--
-- Actor is ALWAYS auth.uid() — there is no actor parameter, so a caller
-- cannot spoof who booked the appointment. Every check below runs before
-- any write; the insert order (task -> ledger -> property updates) matches
-- the plan, and the canonical open-state insert (status='open', no
-- outcome/reminder_claimed_at/completed_*/snoozed_until, generation left at
-- its 0 default) passes the PR-1 tasks_tenant_integrity_guard trigger's
-- INSERT branch without needing sandra.allow_appointment_time_move.
--
-- Contact/property org agreement is NOT re-checked here: the composite FKs
-- tasks_contact_org_fkey / tasks_related_property_org_fkey (both keyed on
-- (id, org_id) against the referenced table) reject the insert outright if
-- p_contact/p_property don't belong to p_org, and the tenant-integrity
-- trigger backs that up independently.
--
-- Idempotency (Codex round 1, PR 2): p_idempotency_key is optional and,
-- when supplied, makes repeat calls with the SAME key safe to retry —
-- sequential replay (the common case: client retries after a dropped
-- response) is caught by the pre-write SELECT below; a genuine race
-- between two concurrent callers presenting the same key is caught by the
-- unique_violation handler around the write section, which re-selects
-- and returns whichever of the two committed first. Either path returns
-- the SAME task_id/calendar_chain_id and duplicate:true — never a second
-- row, never an error surfaced to the caller who "lost" the race.
-- ----------------------------------------------------------------------------
drop function if exists public.fn_book_appointment(
  uuid, uuid, timestamptz, timestamptz, text, text, uuid, uuid, text
);

create or replace function public.fn_book_appointment(
  p_org uuid,
  p_assignee uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_timezone text,
  p_title text,
  p_contact uuid default null,
  p_property uuid default null,
  p_description text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_task_id uuid;
  v_chain_id uuid := gen_random_uuid();
  v_ledger_id uuid;
  v_assignee_tz text;
  v_promoted_rows integer;
  v_already_qualified boolean := false;
  v_duplicate boolean := false;
  v_conflict_constraint text;
begin
  if v_actor is null then
    raise exception 'fn_book_appointment: no authenticated caller' using errcode = '28000';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'fn_book_appointment: title is required' using errcode = 'P0001';
  end if;

  if p_end <= p_start then
    raise exception 'fn_book_appointment: end must be after start' using errcode = 'P0001';
  end if;

  -- Actor must be an active member of the org being booked into.
  perform 1
  from public.memberships m
  where m.user_id = v_actor
    and m.org_id = p_org
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now());
  if not found then
    raise exception 'fn_book_appointment: caller has no active membership in org %', p_org
      using errcode = 'P0001';
  end if;

  -- Assignee must also be an active member of the same org. The tasks
  -- trigger enforces this too (tasks_tenant_integrity_guard, same
  -- predicates), but checking here up front gives a clean, dedicated error
  -- instead of the trigger's generic insert-time exception, and lets us
  -- short-circuit before touching user_integration_prefs.
  perform 1
  from public.memberships m
  where m.user_id = p_assignee
    and m.org_id = p_org
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now());
  if not found then
    raise exception 'fn_book_appointment: assignee has no active membership in org %', p_org
      using errcode = 'P0001';
  end if;

  -- Timezone-label contract: the caller must submit the assignee's
  -- authoritative preference (same lookup as fn_get_member_timezone, done
  -- directly here rather than by calling it — this function's own
  -- membership checks above already establish authorization; routing
  -- through fn_get_member_timezone's separate "shared active org between
  -- CALLER and assignee" check would be redundant and could reject a
  -- caller who is an active org member but who fn_get_member_timezone
  -- would still correctly serve). DST-conversion correctness is proven by
  -- the server-side zoned.ts unit tests, not here — this only guards
  -- against a hostile caller claiming a different zone was used.
  select uip.timezone
  into v_assignee_tz
  from public.user_integration_prefs uip
  where uip.user_id = p_assignee
  order by (uip.channel <> 'google_calendar'), uip.channel
  limit 1;

  v_assignee_tz := coalesce(v_assignee_tz, 'America/Chicago');
  if p_timezone is distinct from v_assignee_tz then
    raise exception 'fn_book_appointment: timezone mismatch (assignee is %, got %)', v_assignee_tz, p_timezone
      using errcode = 'P0001';
  end if;

  -- Sequential replay: a caller resubmitting the same idempotency key
  -- (e.g. after a dropped response) hits this SELECT and returns the
  -- original booking untouched — no second write attempted at all.
  if p_idempotency_key is not null then
    select t.id, t.calendar_chain_id
    into v_task_id, v_chain_id
    from public.tasks t
    where t.org_id = p_org
      and t.booking_idempotency_key = p_idempotency_key;

    if found then
      return jsonb_build_object(
        'task_id', v_task_id,
        'calendar_chain_id', v_chain_id,
        'already_qualified', false,
        'duplicate', true
      );
    end if;
  end if;

  -- Concurrent replay: two callers both miss the SELECT above (neither
  -- has committed yet) and both attempt the insert. The partial unique
  -- index (org_id, booking_idempotency_key) lets exactly one win; the
  -- loser's insert raises unique_violation, caught below, which re-selects
  -- and returns the winner's row instead of surfacing an error. A
  -- unique_violation on any OTHER constraint (or one raised while
  -- p_idempotency_key is null, which should be structurally impossible
  -- since only a booking_idempotency_key collision can fire this index)
  -- is re-raised untouched — this handler must never mask an unrelated
  -- integrity failure as a benign duplicate.
  begin
    insert into public.tasks (
      org_id, assignee_id, related_property_id, contact_id,
      type, status, title, description,
      due_at, end_at, calendar_chain_id, created_by, booking_idempotency_key
    ) values (
      p_org, p_assignee, p_property, p_contact,
      'appointment', 'open', p_title, p_description,
      p_start, p_end, v_chain_id, v_actor, p_idempotency_key
    )
    returning id into v_task_id;

    -- Ledger row born alongside the task, same transaction: initial event
    -- creation gets the same durable pending/provider_done/finalized retry
    -- path as every later lifecycle mutation (PR 3), closing the crash
    -- window where Google creates an event but no row ever records it.
    -- expected_generation=0 matches the task's calendar_generation default.
    insert into public.task_calendar_mutations (
      org_id, calendar_chain_id, operation, phase,
      source_task_id, old_assignee_id, expected_generation
    ) values (
      p_org, v_chain_id, 'create', 'pending',
      v_task_id, p_assignee, 0
    )
    returning id into v_ledger_id;

    update public.task_calendar_mutations
    set client_event_id = public.fn_uuid_to_base32hex(id),
        updated_at = now()
    where id = v_ledger_id;
  exception
    when unique_violation then
      get stacked diagnostics v_conflict_constraint = constraint_name;
      if p_idempotency_key is null
         or v_conflict_constraint <> 'idx_tasks_org_booking_idempotency_key'
      then
        raise;
      end if;

      select t.id, t.calendar_chain_id
      into v_task_id, v_chain_id
      from public.tasks t
      where t.org_id = p_org
        and t.booking_idempotency_key = p_idempotency_key;

      if not found then
        raise;
      end if;

      v_duplicate := true;
  end;

  if v_duplicate then
    return jsonb_build_object(
      'task_id', v_task_id,
      'calendar_chain_id', v_chain_id,
      'already_qualified', false,
      'duplicate', true
    );
  end if;

  if p_property is not null then
    -- Idempotent prospect->lead promotion, same semantics as
    -- qualifyProperty (src/lib/leads/qualify.ts): a no-op (already_qualified
    -- = true) when the property is already past 'prospect'. Single atomic
    -- UPDATE with the status guard in the WHERE clause rather than
    -- qualifyProperty's select-then-update — equivalent result, one fewer
    -- round trip inside an already-open transaction. qualified_by is TEXT
    -- (014_prospect_status.sql:35), holding a user id here same as a
    -- manual qualify.
    update public.properties
    set status = 'new_lead',
        qualified_at = now(),
        qualified_by = v_actor::text,
        updated_at = now()
    where id = p_property
      and status = 'prospect';
    get diagnostics v_promoted_rows = row_count;
    v_already_qualified := (v_promoted_rows = 0);

    -- Thread dispo write mirrors setOutreachDispo's exact shape
    -- (src/app/(dashboard)/messages/dispo-actions.ts:66-73): outreach_dispo,
    -- follow_up_at cleared, updated_at bumped. Unconditional (not gated on
    -- the promotion above) — a lead who already had an appointment booked
    -- and books another still gets its dispo refreshed.
    update public.properties
    set outreach_dispo = 'booked_appointment',
        follow_up_at = null,
        updated_at = now()
    where id = p_property;
  end if;

  return jsonb_build_object(
    'task_id', v_task_id,
    'calendar_chain_id', v_chain_id,
    'already_qualified', v_already_qualified,
    'duplicate', false
  );
end;
$$;

comment on function public.fn_book_appointment(uuid, uuid, timestamptz, timestamptz, text, text, uuid, uuid, text, uuid) is
  'Atomic appointment booking: creates the task, opens its calendar-mutation ledger row, and (property bookings only) promotes prospect->lead + sets booked_appointment dispo. SECURITY DEFINER (see migration header for why this deviates from the plan''s SECURITY INVOKER wording) — actor is always auth.uid(), never a parameter. p_idempotency_key (optional, trailing) makes retries of the same booking safe: same key returns the original task with duplicate:true instead of creating a second row, covering both sequential replay and a genuine concurrent race via the unique_violation handler.';

revoke all on function public.fn_book_appointment(uuid, uuid, timestamptz, timestamptz, text, text, uuid, uuid, text, uuid)
  from public, anon;
grant execute on function public.fn_book_appointment(uuid, uuid, timestamptz, timestamptz, text, text, uuid, uuid, text, uuid)
  to authenticated;

commit;
