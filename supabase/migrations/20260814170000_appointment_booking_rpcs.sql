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
-- ============================================================================

begin;

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
-- ----------------------------------------------------------------------------
create or replace function public.fn_book_appointment(
  p_org uuid,
  p_assignee uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_timezone text,
  p_title text,
  p_contact uuid default null,
  p_property uuid default null,
  p_description text default null
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

  insert into public.tasks (
    org_id, assignee_id, related_property_id, contact_id,
    type, status, title, description,
    due_at, end_at, calendar_chain_id, created_by
  ) values (
    p_org, p_assignee, p_property, p_contact,
    'appointment', 'open', p_title, p_description,
    p_start, p_end, v_chain_id, v_actor
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
    'already_qualified', v_already_qualified
  );
end;
$$;

comment on function public.fn_book_appointment(uuid, uuid, timestamptz, timestamptz, text, text, uuid, uuid, text) is
  'Atomic appointment booking: creates the task, opens its calendar-mutation ledger row, and (property bookings only) promotes prospect->lead + sets booked_appointment dispo. SECURITY DEFINER (see migration header for why this deviates from the plan''s SECURITY INVOKER wording) — actor is always auth.uid(), never a parameter.';

revoke all on function public.fn_book_appointment(uuid, uuid, timestamptz, timestamptz, text, text, uuid, uuid, text)
  from public, anon;
grant execute on function public.fn_book_appointment(uuid, uuid, timestamptz, timestamptz, text, text, uuid, uuid, text)
  to authenticated;

commit;
