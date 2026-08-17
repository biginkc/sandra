-- ============================================================================
-- Fix: cancelling a rescheduled appointment left the pre-reschedule row
-- permanently visible on the calendar as a stale "Rescheduled" card.
--
-- Root cause: fn_reschedule_appointment (20260814210000, section 3) closes
-- the OLD row (status='completed', outcome='rescheduled') and inserts a NEW
-- open successor sharing the same calendar_chain_id. fn_cancel_appointment
-- (20260814210000, section 2) only ever touches the ONE row it's given —
-- when that row is the successor of a reschedule chain, cancelling it flips
-- only the successor to status='cancelled'. The predecessor row is never
-- revisited: it keeps status='completed'/outcome='rescheduled' forever.
--
-- The calendar week view (calendar/queries.ts, buildAppointmentsQuery)
-- reads `.in("status", ["open", "completed"])` — deliberately, so a
-- rescheduled predecessor's "Rescheduled" chip still shows at its
-- original slot as appointment history (that part is correct and
-- unchanged here). But `status = 'completed'` doesn't distinguish "this
-- appointment was rescheduled to a LIVE successor" from "this appointment
-- was rescheduled to a successor whose CHAIN is now cancelled" — the
-- query's own doc comment states the invariant "the calendar surface
-- never shows cancelled appointments", and a permanently-completed/
-- rescheduled predecessor of an now-cancelled chain violates exactly that
-- invariant. Not a caching bug — the calendar page is force-dynamic and
-- revalidated on every lifecycle action; the stale row is genuinely
-- sitting in Postgres with no code path that ever revisits it.
--
-- Fix: fn_cancel_appointment now ALSO flips every predecessor row in the
-- same calendar_chain_id that is sitting in the reschedule-closed state
-- (status='completed', outcome='rescheduled') to status='cancelled',
-- outcome='cancelled' — the same terminal shape the target row itself
-- gets, chosen because it's the only one of the four valid appointment
-- outcomes (held/no_show/rescheduled/cancelled, tasks_outcome_check in
-- 20260814150000) whose STATUS value ('cancelled') falls outside the
-- calendar query's `status IN (open, completed)` filter — completed rows
-- always show, whatever role their outcome plays, so `held`/`no_show`/
-- `rescheduled` outcomes at status='completed' can't be used to hide a row
-- and 'cancelled' is the only combination that both satisfies the CHECK
-- ((status IN (completed, cancelled)) = (outcome IS NOT NULL)) and drops
-- out of the calendar surface. completed_at/completed_by from the
-- original reschedule-close are left untouched (still accurate: that's
-- genuinely when this row stopped being live), only status/outcome/
-- calendar_generation/updated_at change — the same field set every other
-- lifecycle-owned UPDATE in this file touches (migration header,
-- deviation re: cluster (d)). calendar_generation is bumped for the same
-- CAS-consistency reason every other flagged UPDATE in these RPCs bumps
-- it (audit trail + defends any future finalize/read racing against this
-- row's generation), even though no new task_calendar_mutations ledger
-- row is opened for these rows: their own create/reschedule mutation
-- already reached a terminal ledger phase before the chain could reach
-- THIS cancel (the chain-mutation-in-progress guard a few lines up blocks
-- cancel while any ledger row for the chain is still
-- pending/provider_done/needs_repair), so their Google event has already
-- been transferred/reconciled off of them — no provider-side work is
-- needed for a predecessor row, only the visibility flip.
--
-- Multi-hop chains (reschedule -> reschedule -> cancel) are covered: the
-- predecessor UPDATE below is scoped by org_id + calendar_chain_id, not by
-- "the row directly before p_task", so it catches every completed/
-- rescheduled row in the chain in one statement regardless of how many
-- reschedule hops preceded this cancel.
--
-- fn_reassign_appointment and fn_complete_appointment were checked for an
-- analogous gap and do NOT have one:
--   - fn_reassign_appointment never closes a row or creates a successor —
--     it swaps assignee_id in place on the one open row. No predecessor
--     rows exist for it to leave stale.
--   - fn_complete_appointment's terminal state (held/no_show) is meant to
--     stay calendar-visible (status='completed', and completed IS in the
--     query's status filter by design) — and a rescheduled predecessor
--     of a chain that ends in held/no_show is CORRECTLY still shown too:
--     the query's own doc comment describes rescheduled-outcome chips as
--     intentional appointment history, only cancelled chains are
--     supposed to disappear entirely. There's nothing to fix there.
--
-- Idempotent: CREATE OR REPLACE is naturally re-appliable, and the
-- one-time backfill at the bottom (section 2) is guarded by the exact
-- same status/outcome predicate the RPC now maintains going forward, so a
-- second run finds zero matching rows and no-ops.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. fn_cancel_appointment — chain-aware cancel
--
-- Body copied verbatim from 20260814210000 (auth/membership/lock/idempotent
-- checks, the primary UPDATE, and the ledger INSERT are unchanged) with one
-- addition: after the primary target row is cancelled, a second UPDATE
-- flips any completed/rescheduled predecessor rows sharing the same chain
-- to the same cancelled/cancelled shape. `sandra.allow_appointment_time_move`
-- is already 'on' (set once, is_local, persists for the rest of this
-- transaction — same idiom fn_reschedule_appointment relies on for its own
-- two flagged statements) so the second UPDATE doesn't need to re-set it.
-- ----------------------------------------------------------------------------
create or replace function public.fn_cancel_appointment(p_task uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_task public.tasks;
  v_ledger_id uuid;
  v_new_generation integer;
begin
  if v_actor is null then
    raise exception 'fn_cancel_appointment: no authenticated caller' using errcode = '28000';
  end if;

  select * into v_task from public.tasks where id = p_task for update;
  if not found then
    raise exception 'fn_cancel_appointment: task % not found', p_task using errcode = 'P0001';
  end if;
  if v_task.type <> 'appointment' then
    raise exception 'fn_cancel_appointment: task % is not an appointment', p_task using errcode = 'P0001';
  end if;

  perform 1
  from public.memberships m
  where m.user_id = v_actor
    and m.org_id = v_task.org_id
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now())
  for share of m;
  if not found then
    raise exception 'fn_cancel_appointment: caller has no active membership in org %', v_task.org_id
      using errcode = 'P0001';
  end if;

  if v_task.status <> 'open' then
    raise exception 'fn_cancel_appointment: appointment % is not open (status %)', p_task, v_task.status
      using errcode = 'P0001';
  end if;

  perform 1
  from public.task_calendar_mutations
  where org_id = v_task.org_id
    and calendar_chain_id = v_task.calendar_chain_id
    and phase in ('pending', 'provider_done', 'needs_repair')
  for update;
  if found then
    raise exception 'fn_cancel_appointment: calendar sync in progress for this appointment'
      using errcode = 'P0001';
  end if;

  perform set_config('sandra.allow_appointment_time_move', 'on', true);

  update public.tasks
  set status = 'cancelled',
      outcome = 'cancelled',
      calendar_generation = calendar_generation + 1,
      updated_at = now()
  where id = p_task
  returning calendar_generation into v_new_generation;

  -- Chain-terminal cancel visibility fix (this migration): every earlier
  -- hop of this chain that a prior reschedule closed out (status=completed,
  -- outcome=rescheduled) is now dead history of a CANCELLED chain, not of a
  -- still-live one — flip it the same way so the calendar's
  -- `status IN (open, completed)` filter drops it too. Scoped by org and
  -- calendar_chain_id (not "the immediately preceding row"), so a
  -- multi-hop chain (reschedule, reschedule, cancel) clears every
  -- predecessor in this one statement. completed_at/completed_by are left
  -- as-is (still accurate — that's genuinely when each hop stopped being
  -- live); no ledger row is opened because these rows' own
  -- create/reschedule mutations already reached a terminal ledger phase
  -- (the chain-mutation-in-progress guard above would have blocked this
  -- cancel otherwise), so there is no outstanding Google-side work for
  -- them, only the visibility flip.
  update public.tasks
  set status = 'cancelled',
      outcome = 'cancelled',
      calendar_generation = calendar_generation + 1,
      updated_at = now()
  where org_id = v_task.org_id
    and calendar_chain_id = v_task.calendar_chain_id
    and status = 'completed'
    and outcome = 'rescheduled';

  -- event_id captured from the row read at lock time — the ledger's own
  -- record of "which event to delete", read by the worker, never a live
  -- re-read of tasks.google_calendar_event_id (see migration header,
  -- deviation 4). expected_generation is the POST-bump value: that's what
  -- calendar_generation actually holds the instant this transaction
  -- commits, and the worker's finalize CAS checks against the persisted
  -- value.
  insert into public.task_calendar_mutations (
    org_id, calendar_chain_id, operation, phase,
    source_task_id, old_assignee_id, event_id, expected_generation
  ) values (
    v_task.org_id, v_task.calendar_chain_id, 'cancel', 'pending',
    p_task, v_task.assignee_id, v_task.google_calendar_event_id, v_new_generation
  )
  returning id into v_ledger_id;

  return jsonb_build_object('task_id', p_task, 'status', 'cancelled', 'ledger_id', v_ledger_id);
end;
$$;

comment on function public.fn_cancel_appointment(uuid) is
  'Cancels an open appointment and opens a cancel/pending ledger row so the worker deletes the Google event (404 = idempotent success). This migration (20260816090000): also cancels every completed/rescheduled predecessor row sharing the same organization and chain, so a reschedule->cancel chain drops off the calendar entirely instead of leaving the pre-reschedule row stuck showing a stale "Rescheduled" chip forever — see this migration''s header for the full root-cause writeup. SECURITY DEFINER: see 20260814210000 migration header.';

-- ----------------------------------------------------------------------------
-- 2. One-time backfill for existing prod data — chains that were already
--    reschedule->cancel'd before this fix landed still have their
--    predecessor row(s) stuck at completed/rescheduled. Same predicate the
--    RPC now maintains going forward: "the chain's most-recently-created
--    row is cancelled" identifies a terminally-cancelled chain (a
--    reschedule successor is always inserted with a later created_at than
--    its predecessor, so the newest row per chain is the chain's current
--    logical state); any OTHER row in that same chain still sitting at
--    completed/rescheduled is stale and gets the same visibility flip.
--
--    Idempotent: after the first run, no task row anywhere matches
--    status='completed' AND outcome='rescheduled' inside a
--    terminally-cancelled chain (they're all 'cancelled' now), so a
--    second run of this exact statement updates zero rows.
--
--    A chain that was reschedule -> reschedule -> cancel is covered the
--    same way: chain_terminal identifies the chain via its single newest
--    row (the cancelled one), and every earlier hop's completed/
--    rescheduled row is joined and flipped in the same UPDATE.
--
--    True-DNC records are deliberately excluded. Migration 20260815190000
--    makes both property-linked and contact-only task rows read-only after
--    the permanent compliance lock ratchets. Historical cleanup must honor
--    that guard instead of bypassing it or aborting this forward migration.
-- ----------------------------------------------------------------------------
select set_config('sandra.allow_appointment_time_move', 'on', true);

do $$
declare
  candidate record;
  contact_is_dnc boolean;
  linked_property_is_locked boolean;
  related_property_is_locked boolean;
  dnc_error_message text;
begin
  for candidate in
    with chain_terminal as (
      select distinct on (org_id, calendar_chain_id)
        org_id,
        calendar_chain_id,
        status as terminal_status
      from public.tasks
      where type = 'appointment'
      order by org_id, calendar_chain_id, created_at desc, id desc
    )
    select
      t.id,
      t.org_id,
      t.contact_id,
      t.related_property_id
    from public.tasks t
    join chain_terminal ct
      on ct.org_id = t.org_id
     and ct.calendar_chain_id = t.calendar_chain_id
    where ct.terminal_status = 'cancelled'
      and t.status = 'completed'
      and t.outcome = 'rescheduled'
    order by t.org_id, t.contact_id nulls first,
      t.related_property_id nulls first, t.id
  loop
    contact_is_dnc := false;
    linked_property_is_locked := false;
    related_property_is_locked := false;

    -- Match the permanent-DNC trigger's canonical CONTACT -> PROPERTY lock
    -- order before touching the task. A concurrent one-way DNC ratchet then
    -- either completes first (and this row is skipped after recheck) or waits
    -- until this historical cleanup finishes; it cannot make the migration
    -- update a task first and then fail the whole transaction at the trigger.
    if candidate.contact_id is not null then
      select c.do_not_contact
      into contact_is_dnc
      from public.contacts c
      where c.id = candidate.contact_id
        and c.org_id = candidate.org_id
      for no key update;

      perform 1
      from public.properties p
      where p.homeowner_contact_id = candidate.contact_id
        and p.org_id = candidate.org_id
      order by p.id
      for no key update;

      select exists (
        select 1
        from public.properties p
        where p.homeowner_contact_id = candidate.contact_id
          and p.org_id = candidate.org_id
          and p.is_dnc_locked
      ) into linked_property_is_locked;
    end if;

    if candidate.related_property_id is not null then
      select p.is_dnc_locked
      into related_property_is_locked
      from public.properties p
      where p.id = candidate.related_property_id
        and p.org_id = candidate.org_id
      for no key update;
    end if;

    if coalesce(contact_is_dnc, false)
      or coalesce(linked_property_is_locked, false)
      or coalesce(related_property_is_locked, false)
    then
      continue;
    end if;

    begin
      update public.tasks t
      set status = 'cancelled',
          outcome = 'cancelled',
          calendar_generation = t.calendar_generation + 1,
          updated_at = now()
      where t.id = candidate.id
        and t.org_id = candidate.org_id
        and t.status = 'completed'
        and t.outcome = 'rescheduled';
    exception when sqlstate 'P0001' then
      get stacked diagnostics dnc_error_message = message_text;
      if dnc_error_message not like 'DNC_LOCKED:%' then
        raise;
      end if;
      -- Defense in depth for a relationship change between candidate
      -- discovery and the locked recheck. Never bypass the DNC trigger;
      -- skip only its explicit immutable-history rejection.
    end;
  end loop;
end
$$;

commit;
