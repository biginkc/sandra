-- ============================================================================
-- Sandra Appointments — PR 3: lifecycle RPCs (complete / cancel / reschedule
-- / reassign) + widened calendar-mutation claim/exhaustion sweep.
--
-- Full plan: reactive-puzzling-crane.md v9, "Calendar lifecycle = durable
-- mutation ledger" (PR 3 section) + "Uniform lock protocol" (R7-1/R8-1) +
-- the PR-1 implementation-deviations block (sandra.allow_appointment_time_move).
--
-- ----------------------------------------------------------------------------
-- Deviations from the plan text (documented for Codex review)
-- ----------------------------------------------------------------------------
-- 1. SECURITY DEFINER, not SECURITY INVOKER. Same reason as PR 2's
--    fn_book_appointment (20260814170000 header): task_calendar_mutations
--    INSERT is REVOKEd from anon/authenticated (20260814150000:610-611), so
--    an invoker-rights cancel/reschedule/reassign could never write its own
--    ledger row. All four lifecycle RPCs below are SECURITY DEFINER with a
--    pinned search_path and do their own explicit auth/membership checks
--    rather than relying on RLS.
-- 2. [SUPERSEDED by Codex round 1, finding 5 — kept for history.]
--    fn_reassign_appointment's p_idempotency_key was originally accepted
--    for signature symmetry with fn_reschedule_appointment but not
--    persisted; retry-safety relied on inferring "no-op" from "task already
--    on the target assignee". That inference was wrong: a delayed replay of
--    an EARLIER A->B call, arriving after an intervening B->A reassignment
--    had already restored the original assignee, would NOT match "already
--    on target" (current assignee is A, not B) and would fall through to a
--    genuine reassignment — silently undoing the intervening B->A the
--    caller never asked to touch. The key is now persisted
--    (task_calendar_mutations.reassign_idempotency_key, section 3b below)
--    and is the ONLY no-op replay path — see fn_reassign_appointment's own
--    comment for the full rationale.
-- 3. Claim RPC rename + widening, no compatibility shim.
--    fn_claim_calendar_creations(integer) (PR 2, `create`-only) is DROPped
--    and replaced by fn_claim_calendar_mutations(integer), widened to
--    operation IN ('create','reschedule','reassign','cancel') and returning
--    both the source task's and (nullable, reschedule-only) the target
--    successor's due_at/end_at/title/assignee_id so create-worker.ts can
--    dispatch by `operation` without a second round trip. No back-compat
--    signature is kept: the sole caller is
--    src/app/api/cron/calendar-mutation-sweep/route.ts, owned by this same
--    PR, and its call site is updated alongside this migration in one
--    atomic change. fn_expire_exhausted_calendar_creations() is renamed the
--    same way, to fn_expire_exhausted_calendar_mutations(), and its WHERE
--    clause drops the `operation = 'create'` filter — a stuck
--    reschedule/reassign/cancel row at attempts>=5 would otherwise hold its
--    chain-serialization slot open forever with no terminal-exhaustion path
--    at all, which is strictly worse than the create-only gap it already
--    closed in PR 2.
-- 4. Cross-operation event-id source of truth. Every provider step below
--    (delete for cancel, update for reschedule, delete-then-create for
--    reassign) reads the Google event id the ledger row CAPTURED at
--    RPC-write time (`event_id`), never a live re-read of
--    tasks.google_calendar_event_id from the claim — the ledger is the
--    single source of lineage per the plan ("Provider step reads the
--    LEDGER, never infers lineage from task rows"), and re-reading the live
--    column at claim time would reopen exactly the TOCTOU gap the ledger
--    exists to close.
--
-- ----------------------------------------------------------------------------
-- sandra.allow_appointment_time_move — per-statement usage across all four
-- RPCs (worked out against the ACTUAL trigger text in 20260814150000,
-- section 3, not just the plan's prose)
-- ----------------------------------------------------------------------------
-- The trigger's UPDATE branch gates FOUR disjoint field clusters behind the
-- flag: (a) due_at/end_at, (b) type/calendar_chain_id, (c) assignee_id, (d)
-- status/outcome/reminder_claimed_at/calendar_generation/completed_*/
-- snoozed_until/booking_idempotency_key. It does NOT gate
-- google_calendar_event_id at all — that column is free to write from any
-- session, which is how PR 2's create-worker.ts already updates it with no
-- flag (finalizeCreation, create-worker.ts:557-563). Consequences used
-- below:
--   - fn_complete_appointment: the closing UPDATE touches status, outcome,
--     completed_at, completed_by, calendar_generation — all cluster (d).
--     Flag required.
--   - fn_cancel_appointment: same cluster (d) fields (status, outcome,
--     calendar_generation). Flag required. The worker's later
--     google_calendar_event_id=null cleanup write is UNFLAGGED (free
--     column), same as every other worker write in this file.
--   - fn_reschedule_appointment: the OLD row's closing UPDATE touches
--     cluster (d) (status, outcome, completed_at, completed_by,
--     calendar_generation) — flag required for that UPDATE. The successor
--     INSERT does NOT need the flag: the trigger's INSERT branch only
--     raises when an appointment is inserted in a NON-canonical-open state
--     (status<>'open', or outcome/reminder_claimed_at/calendar_generation/
--     completed_*/snoozed_until already set) — see 20260814150000:266-279.
--     The successor is inserted status='open', no outcome, no
--     reminder_claimed_at, calendar_generation left at its 0 default, no
--     completed_*/snoozed_until — the SAME canonical-open shape
--     fn_book_appointment already inserts without the flag
--     (20260814170000:705-714). The flag being ON from the prior statement
--     has zero effect on this INSERT either way (the guard condition is
--     false regardless of the flag), so no separate perform/reset is
--     needed around the two statements.
--   - fn_reassign_appointment: the UPDATE touches assignee_id (cluster c)
--     and calendar_generation (cluster d). Flag required.
-- Every RPC calls `perform set_config('sandra.allow_appointment_time_move',
-- 'on', true)` exactly once, immediately before its one flagged UPDATE,
-- with `is_local => true` so it never leaks past this transaction (matches
-- the trigger's own `current_setting(..., true)` missing-GUC-tolerant read).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. fn_complete_appointment — held / no_show outcome, no ledger row
--
-- Per the plan, completion never touches the calendar (the event stays —
-- "complete -> keep event"), so there is no provider step and no ledger
-- write here. It still participates in the uniform lock protocol (lock,
-- re-check status + active-mutation absence, bump calendar_generation) so a
-- finalize CAS from an in-flight create/reassign/reschedule that raced this
-- completion loses instead of silently resurrecting/moving an event on a
-- now-completed appointment.
-- ----------------------------------------------------------------------------
create or replace function public.fn_complete_appointment(
  p_task uuid,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_task public.tasks;
begin
  if v_actor is null then
    raise exception 'fn_complete_appointment: no authenticated caller' using errcode = '28000';
  end if;

  if p_outcome not in ('held', 'no_show') then
    raise exception 'fn_complete_appointment: outcome must be held or no_show, got %', p_outcome
      using errcode = 'P0001';
  end if;

  select * into v_task from public.tasks where id = p_task for update;
  if not found then
    raise exception 'fn_complete_appointment: task % not found', p_task using errcode = 'P0001';
  end if;
  if v_task.type <> 'appointment' then
    raise exception 'fn_complete_appointment: task % is not an appointment', p_task using errcode = 'P0001';
  end if;

  -- Actor must be an active member of the appointment's org. Same
  -- FOR SHARE OF m idiom as fn_book_appointment (Codex round 2 race
  -- protection) and the tenant-integrity trigger's own assignee check.
  perform 1
  from public.memberships m
  where m.user_id = v_actor
    and m.org_id = v_task.org_id
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now())
  for share of m;
  if not found then
    raise exception 'fn_complete_appointment: caller has no active membership in org %', v_task.org_id
      using errcode = 'P0001';
  end if;

  if v_task.status <> 'open' then
    raise exception 'fn_complete_appointment: appointment % is not open (status %)', p_task, v_task.status
      using errcode = 'P0001';
  end if;

  -- Uniform lock protocol, part (c): reject while any chain mutation is
  -- in-flight or unreconciled. FOR UPDATE here (not FOR SHARE) locks the
  -- candidate ledger row too, so a worker's own token-fenced UPDATE against
  -- it (an ordinary PostgREST call, not itself transactional) simply waits
  -- for this transaction to commit or roll back rather than racing it.
  perform 1
  from public.task_calendar_mutations
  where calendar_chain_id = v_task.calendar_chain_id
    and phase in ('pending', 'provider_done', 'needs_repair')
  for update;
  if found then
    raise exception 'fn_complete_appointment: calendar sync in progress for this appointment'
      using errcode = 'P0001';
  end if;

  perform set_config('sandra.allow_appointment_time_move', 'on', true);

  update public.tasks
  set status = 'completed',
      outcome = p_outcome,
      completed_at = now(),
      completed_by = v_actor,
      calendar_generation = calendar_generation + 1,
      updated_at = now()
  where id = p_task;

  return jsonb_build_object('task_id', p_task, 'status', 'completed', 'outcome', p_outcome);
end;
$$;

comment on function public.fn_complete_appointment(uuid, text) is
  'Closes an appointment as held/no_show. No ledger row (the Google event is kept, per plan) — participates in the uniform lock protocol (FOR UPDATE, status + active-mutation re-check, generation bump) purely to invalidate a racing finalize. SECURITY DEFINER: see migration header.';

revoke all on function public.fn_complete_appointment(uuid, text) from public, anon;
grant execute on function public.fn_complete_appointment(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. fn_cancel_appointment — status cancelled, ledger 'cancel'/'pending'
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
  where calendar_chain_id = v_task.calendar_chain_id
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
  'Cancels an open appointment and opens a cancel/pending ledger row so the worker deletes the Google event (404 = idempotent success). SECURITY DEFINER: see migration header.';

revoke all on function public.fn_cancel_appointment(uuid) from public, anon;
grant execute on function public.fn_cancel_appointment(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. fn_reschedule_appointment — successor-row model
--
-- Closes the old row (completed/rescheduled) and inserts a successor open
-- row carrying the SAME calendar_chain_id, assignee, and property/contact
-- links — the chain's logical identity survives across the row boundary.
-- Reuses tasks.booking_idempotency_key (PR 2 schema, appointment-only,
-- unique per (org_id, key)) for replay safety on the successor rather than
-- inventing new schema.
--
-- No unique_violation handler is needed here the way fn_book_appointment
-- needs one: booking has no pre-existing row to lock, so two concurrent
-- callers can both reach its INSERT before either commits. Reschedule
-- always locks an EXISTING row first (`select ... for update` below) — a
-- second concurrent call with the same key blocks on that lock, then (once
-- the first commits) sees the row already 'completed' and finds the
-- successor via the replay lookup below, so the replay-before-validation
-- branch alone covers both sequential retry AND the concurrent race.
-- ----------------------------------------------------------------------------
create or replace function public.fn_reschedule_appointment(
  p_task uuid,
  p_new_start timestamptz,
  p_new_end timestamptz,
  p_timezone text,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_task public.tasks;
  v_existing public.tasks;
  v_assignee_tz text;
  v_successor_id uuid;
  v_ledger_id uuid;
begin
  if v_actor is null then
    raise exception 'fn_reschedule_appointment: no authenticated caller' using errcode = '28000';
  end if;

  select * into v_task from public.tasks where id = p_task for update;
  if not found then
    raise exception 'fn_reschedule_appointment: task % not found', p_task using errcode = 'P0001';
  end if;
  if v_task.type <> 'appointment' then
    raise exception 'fn_reschedule_appointment: task % is not an appointment', p_task using errcode = 'P0001';
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
    raise exception 'fn_reschedule_appointment: caller has no active membership in org %', v_task.org_id
      using errcode = 'P0001';
  end if;

  -- Replay-before-validation (same idiom as fn_book_appointment): a repeat
  -- call with the same key must return the already-created successor even
  -- though the OLD row is now 'completed' (which would otherwise trip the
  -- expected-status check below) and even if the assignee's timezone pref
  -- has since changed.
  if p_idempotency_key is not null then
    select * into v_existing
    from public.tasks
    where org_id = v_task.org_id
      and calendar_chain_id = v_task.calendar_chain_id
      and booking_idempotency_key = p_idempotency_key;

    if found then
      if v_existing.due_at is distinct from p_new_start
         or v_existing.end_at is distinct from p_new_end
      then
        raise exception 'fn_reschedule_appointment: idempotency key reuse with different request'
          using errcode = 'P0001';
      end if;
      return jsonb_build_object(
        'task_id', v_existing.id,
        'old_task_id', v_task.id,
        'calendar_chain_id', v_task.calendar_chain_id,
        'duplicate', true
      );
    end if;
  end if;

  if v_task.status <> 'open' then
    raise exception 'fn_reschedule_appointment: appointment % is not open (status %)', p_task, v_task.status
      using errcode = 'P0001';
  end if;

  perform 1
  from public.task_calendar_mutations
  where calendar_chain_id = v_task.calendar_chain_id
    and phase in ('pending', 'provider_done', 'needs_repair')
  for update;
  if found then
    raise exception 'fn_reschedule_appointment: calendar sync in progress for this appointment'
      using errcode = 'P0001';
  end if;

  -- Timezone-label contract, same as fn_book_appointment: the assignee is
  -- unchanged by reschedule, so it's validated against THEIR authoritative
  -- pref (not a caller-supplied assignee).
  select uip.timezone
  into v_assignee_tz
  from public.user_integration_prefs uip
  where uip.user_id = v_task.assignee_id
  order by (uip.channel <> 'google_calendar'), uip.channel
  limit 1;
  v_assignee_tz := coalesce(v_assignee_tz, 'America/Chicago');
  if p_timezone is distinct from v_assignee_tz then
    raise exception 'fn_reschedule_appointment: timezone mismatch (assignee is %, got %)', v_assignee_tz, p_timezone
      using errcode = 'P0001';
  end if;

  -- Window validation — same bounds as fn_book_appointment (20260814170000).
  if not isfinite(p_new_start) or not isfinite(p_new_end) then
    raise exception 'fn_reschedule_appointment: start/end must be finite timestamps' using errcode = 'P0001';
  end if;
  if p_new_end <= p_new_start then
    raise exception 'fn_reschedule_appointment: end must be after start' using errcode = 'P0001';
  end if;
  if p_new_end - p_new_start < interval '15 minutes' or p_new_end - p_new_start > interval '24 hours' then
    raise exception 'fn_reschedule_appointment: appointment duration must be between 15 minutes and 24 hours'
      using errcode = 'P0001';
  end if;
  if p_new_start > now() + interval '2 years' or p_new_start < now() - interval '1 hour' then
    raise exception 'fn_reschedule_appointment: start must be within 1 hour in the past and 2 years in the future'
      using errcode = 'P0001';
  end if;

  -- Flag required for THIS statement (cluster d: status/outcome/
  -- completed_*/calendar_generation) — see migration header. The successor
  -- INSERT right after does NOT need it (canonical open state); left ON is
  -- harmless for that statement either way.
  perform set_config('sandra.allow_appointment_time_move', 'on', true);

  update public.tasks
  set status = 'completed',
      outcome = 'rescheduled',
      completed_at = now(),
      completed_by = v_actor,
      calendar_generation = calendar_generation + 1,
      updated_at = now()
  where id = p_task;

  insert into public.tasks (
    org_id, assignee_id, related_property_id, contact_id,
    type, status, title, description,
    due_at, end_at, calendar_chain_id, created_by, booking_idempotency_key
  ) values (
    v_task.org_id, v_task.assignee_id, v_task.related_property_id, v_task.contact_id,
    'appointment', 'open', v_task.title, v_task.description,
    p_new_start, p_new_end, v_task.calendar_chain_id, v_actor, p_idempotency_key
  )
  returning id into v_successor_id;

  -- expected_generation = 0: the successor's OWN generation, fresh off the
  -- default — an entirely different row/generation pair than the old row's
  -- just-bumped value. event_id is the OLD row's event (captured before the
  -- close above changed nothing about that column — it is never touched by
  -- this RPC, only read).
  insert into public.task_calendar_mutations (
    org_id, calendar_chain_id, operation, phase,
    source_task_id, target_task_id, old_assignee_id, event_id, expected_generation
  ) values (
    v_task.org_id, v_task.calendar_chain_id, 'reschedule', 'pending',
    p_task, v_successor_id, v_task.assignee_id, v_task.google_calendar_event_id, 0
  )
  returning id into v_ledger_id;

  return jsonb_build_object(
    'task_id', v_successor_id,
    'old_task_id', p_task,
    'calendar_chain_id', v_task.calendar_chain_id,
    'duplicate', false
  );
end;
$$;

comment on function public.fn_reschedule_appointment(uuid, timestamptz, timestamptz, text, uuid) is
  'Successor-row reschedule: closes the old task (completed/rescheduled) and inserts an open successor sharing calendar_chain_id/assignee/links, then opens a reschedule/pending ledger row (event_id = old row''s event, target_task_id = successor, expected_generation = 0 = the successor''s own generation) so the worker updates the Google event under the unchanged assignee''s token and CAS-transfers google_calendar_event_id old->successor. SECURITY DEFINER: see migration header.';

revoke all on function public.fn_reschedule_appointment(uuid, timestamptz, timestamptz, text, uuid) from public, anon;
grant execute on function public.fn_reschedule_appointment(uuid, timestamptz, timestamptz, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3b. task_calendar_mutations — reassign replay key (Codex round 1)
--
-- Same shape as tasks.booking_idempotency_key (20260814170000): nullable,
-- populated only by a keyed caller, unique per (org_id, key) so two
-- DIFFERENT chains can never collide on an accidentally-reused client key.
-- fn_reassign_appointment looks it up scoped to the specific chain (a
-- chain-wide uniqueness would be redundant given the org-scoped index, but
-- the lookup itself only ever needs "this chain's" row).
-- ----------------------------------------------------------------------------
alter table public.task_calendar_mutations
  add column reassign_idempotency_key uuid;

comment on column public.task_calendar_mutations.reassign_idempotency_key is
  'Codex round 1 (finding 5): replay key for fn_reassign_appointment, stamped on the ledger row a keyed reassign call creates. A repeat call presenting the SAME key returns THIS row''s original result (duplicate:true) regardless of the appointment''s CURRENT assignee — closes the A->B->A replay hazard where inferring "no-op" from "already on target assignee" would silently undo an intervening B->A reassignment. NULL for unkeyed reassigns; each unkeyed call is a fresh operation, serialized (never raced) by the RPC''s own row lock.';

create unique index idx_task_calendar_mutations_reassign_idem
  on public.task_calendar_mutations (org_id, reassign_idempotency_key)
  where operation = 'reassign' and reassign_idempotency_key is not null;

-- ----------------------------------------------------------------------------
-- 4. fn_reassign_appointment — swaps assignee under the flag
--
-- Codex round 1 (finding 5) rewrite: p_idempotency_key is now PERSISTED
-- (task_calendar_mutations.reassign_idempotency_key, ALTERed in below) and
-- is the ONLY no-op replay path. The old "already on target assignee"
-- inference is removed entirely — it made A->B->A replayable-wrong: a
-- delayed retry of an EARLIER A->B call, arriving after an intervening
-- B->A reassignment already restored the original assignee, would read
-- "assignee_id = p_new_assignee (B)? no, it's A" and — before this fix —
-- fall through to a genuine C->B-shaped reassignment, silently undoing the
-- intervening operation the caller never asked to undo. A keyed replay
-- looks up the SAME ledger row by key and returns ITS original result
-- (duplicate:true) regardless of the appointment's CURRENT assignee; an
-- unkeyed call is always a fresh operation, serialized (never raced) by
-- this function's own `select ... for update` row lock.
-- ----------------------------------------------------------------------------
create or replace function public.fn_reassign_appointment(
  p_task uuid,
  p_new_assignee uuid,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_task public.tasks;
  v_existing_ledger public.task_calendar_mutations;
  v_old_assignee uuid;
  v_old_event_id text;
  v_new_generation integer;
  v_ledger_id uuid;
begin
  if v_actor is null then
    raise exception 'fn_reassign_appointment: no authenticated caller' using errcode = '28000';
  end if;
  if p_new_assignee is null then
    raise exception 'fn_reassign_appointment: new assignee is required' using errcode = 'P0001';
  end if;

  select * into v_task from public.tasks where id = p_task for update;
  if not found then
    raise exception 'fn_reassign_appointment: task % not found', p_task using errcode = 'P0001';
  end if;
  if v_task.type <> 'appointment' then
    raise exception 'fn_reassign_appointment: task % is not an appointment', p_task using errcode = 'P0001';
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
    raise exception 'fn_reassign_appointment: caller has no active membership in org %', v_task.org_id
      using errcode = 'P0001';
  end if;

  -- Replay-before-validation (same idiom as fn_book_appointment /
  -- fn_reschedule_appointment): a keyed retry must return the ORIGINAL
  -- operation's result, found by key alone — never inferred from the
  -- appointment's current assignee, which may have moved again since (the
  -- A->B->A hazard this rewrite closes). Chain-scoped, not task-scoped: a
  -- reassign's source_task_id IS this task for as long as the chain hasn't
  -- also been through a reschedule in between; the mismatched-request
  -- check below still catches a key reused against a genuinely different
  -- request (different task in the chain, or a different target).
  if p_idempotency_key is not null then
    select * into v_existing_ledger
    from public.task_calendar_mutations
    where calendar_chain_id = v_task.calendar_chain_id
      and operation = 'reassign'
      and reassign_idempotency_key = p_idempotency_key
    order by created_at desc
    limit 1;

    if found then
      if v_existing_ledger.source_task_id is distinct from p_task
         or v_existing_ledger.new_assignee_id is distinct from p_new_assignee
      then
        raise exception 'fn_reassign_appointment: idempotency key reuse with different request'
          using errcode = 'P0001';
      end if;
      return jsonb_build_object(
        'task_id', v_existing_ledger.source_task_id,
        'old_assignee_id', v_existing_ledger.old_assignee_id,
        'new_assignee_id', v_existing_ledger.new_assignee_id,
        'duplicate', true
      );
    end if;
  end if;

  if v_task.status <> 'open' then
    raise exception 'fn_reassign_appointment: appointment % is not open (status %)', p_task, v_task.status
      using errcode = 'P0001';
  end if;

  perform 1
  from public.task_calendar_mutations
  where calendar_chain_id = v_task.calendar_chain_id
    and phase in ('pending', 'provider_done', 'needs_repair')
  for update;
  if found then
    raise exception 'fn_reassign_appointment: calendar sync in progress for this appointment'
      using errcode = 'P0001';
  end if;

  -- New assignee must be an ACTIVE member of the same org (plan point 4,
  -- FOR SHARE) — same predicates/idiom as fn_book_appointment's assignee
  -- check.
  perform 1
  from public.memberships m
  where m.user_id = p_new_assignee
    and m.org_id = v_task.org_id
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now())
  for share of m;
  if not found then
    raise exception 'fn_reassign_appointment: new assignee has no active membership in org %', v_task.org_id
      using errcode = 'P0001';
  end if;

  v_old_assignee := v_task.assignee_id;
  v_old_event_id := v_task.google_calendar_event_id;

  perform set_config('sandra.allow_appointment_time_move', 'on', true);

  update public.tasks
  set assignee_id = p_new_assignee,
      calendar_generation = calendar_generation + 1,
      updated_at = now()
  where id = p_task
  returning calendar_generation into v_new_generation;

  insert into public.task_calendar_mutations (
    org_id, calendar_chain_id, operation, phase,
    source_task_id, old_assignee_id, new_assignee_id, event_id, expected_generation,
    reassign_idempotency_key
  ) values (
    v_task.org_id, v_task.calendar_chain_id, 'reassign', 'pending',
    p_task, v_old_assignee, p_new_assignee, v_old_event_id, v_new_generation,
    p_idempotency_key
  )
  returning id into v_ledger_id;

  -- Deterministic client-supplied event id for the CREATE-under-new-assignee
  -- half of the reassign (R6-2 idempotency, same derivation as
  -- fn_book_appointment) — the delete-under-old-assignee half needs no such
  -- id; a delete is naturally idempotent (404 = already gone = success).
  update public.task_calendar_mutations
  set client_event_id = public.fn_uuid_to_base32hex(id),
      updated_at = now()
  where id = v_ledger_id;

  return jsonb_build_object(
    'task_id', p_task,
    'old_assignee_id', v_old_assignee,
    'new_assignee_id', p_new_assignee,
    'duplicate', false
  );
end;
$$;

comment on function public.fn_reassign_appointment(uuid, uuid, uuid) is
  'Reassigns an open appointment to a new (active, same-org) assignee and opens a reassign/pending ledger row (old_assignee_id/new_assignee_id, event_id = the old event to delete, a fresh client_event_id for the new-account create) so the worker deletes the event under the old account (404 = idempotent success) and creates it under the new one. SECURITY DEFINER: see migration header.';

revoke all on function public.fn_reassign_appointment(uuid, uuid, uuid) from public, anon;
grant execute on function public.fn_reassign_appointment(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. fn_claim_calendar_mutations — widened claim, renamed from PR 2's
--    fn_claim_calendar_creations. See migration header, deviation 3.
-- ----------------------------------------------------------------------------
drop function if exists public.fn_claim_calendar_creations(integer);
drop function if exists public.fn_expire_exhausted_calendar_creations();

create or replace function public.fn_claim_calendar_mutations(p_limit integer)
returns table (
  ledger_id uuid,
  org_id uuid,
  calendar_chain_id uuid,
  operation text,
  phase text,
  source_task_id uuid,
  target_task_id uuid,
  old_assignee_id uuid,
  new_assignee_id uuid,
  event_id text,
  new_event_id text,
  client_event_id text,
  result_reason text,
  expected_generation integer,
  attempts integer,
  claim_token uuid,
  source_due_at timestamptz,
  source_end_at timestamptz,
  source_title text,
  source_assignee_id uuid,
  target_due_at timestamptz,
  target_end_at timestamptz,
  target_title text,
  target_assignee_id uuid
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with claimed as (
    update public.task_calendar_mutations m
    set attempts = m.attempts + 1,
        next_attempt_at = now() + interval '2 minutes',
        claim_token = gen_random_uuid(),
        updated_at = now()
    from (
      select id
      from public.task_calendar_mutations
      where operation in ('create', 'reschedule', 'reassign', 'cancel')
        and phase in ('pending', 'provider_done')
        and attempts < 5
        and (next_attempt_at is null or next_attempt_at <= now())
      order by created_at
      for update skip locked
      limit greatest(p_limit, 0)
    ) locked
    where m.id = locked.id
    returning
      m.id, m.org_id, m.calendar_chain_id, m.operation, m.phase, m.source_task_id,
      m.target_task_id, m.old_assignee_id, m.new_assignee_id, m.event_id, m.new_event_id,
      m.client_event_id, m.result_reason, m.expected_generation, m.attempts, m.claim_token
  )
  select
    claimed.id, claimed.org_id, claimed.calendar_chain_id, claimed.operation, claimed.phase,
    claimed.source_task_id, claimed.target_task_id, claimed.old_assignee_id, claimed.new_assignee_id,
    claimed.event_id, claimed.new_event_id, claimed.client_event_id, claimed.result_reason,
    claimed.expected_generation, claimed.attempts, claimed.claim_token,
    src.due_at, src.end_at, src.title, src.assignee_id,
    tgt.due_at, tgt.end_at, tgt.title, tgt.assignee_id
  from claimed
  join public.tasks src on src.id = claimed.source_task_id
  left join public.tasks tgt on tgt.id = claimed.target_task_id;
$$;

comment on function public.fn_claim_calendar_mutations(integer) is
  'Service-role-only claim for the durable calendar-mutation sweep worker — PR 3 rename+widening of PR 2''s fn_claim_calendar_creations (no compatibility shim; sole caller calendar-mutation-sweep/route.ts updated in this PR). Same FOR UPDATE SKIP LOCKED / 2-minute lease / claim_token fencing, widened to operation IN (create, reschedule, reassign, cancel). LEFT JOINs the nullable target/successor task (reschedule only) alongside the source task so the worker can dispatch on `operation` without a second round trip.';

revoke all on function public.fn_claim_calendar_mutations(integer) from public, anon, authenticated;
grant execute on function public.fn_claim_calendar_mutations(integer) to service_role;

-- ----------------------------------------------------------------------------
-- 6. fn_expire_exhausted_calendar_mutations — widened, renamed from PR 2's
--    fn_expire_exhausted_calendar_creations. Same failed/needs_repair split;
--    the only change from PR 2 was dropping the `operation = 'create'`
--    filter. Codex round 1 (finding 4) adds a SECOND needs_repair trigger:
--    a row still at phase='pending' whose result_reason is
--    'no_token_stale_event' or 'pref_disabled_stale_event' — the
--    create-worker's markStaleEventRetryable (create-worker.ts) — never
--    reached phase='provider_done' (no provider call was ever made; the
--    token/pref was missing before that point) but still represents a
--    KNOWN Google event this operation could not reconcile. Routing it to
--    plain 'failed' would free the chain-serialization slot over a
--    genuinely unreconciled event; needs_repair correctly keeps it held
--    (same rationale as the provider_done branch).
-- ----------------------------------------------------------------------------
create or replace function public.fn_expire_exhausted_calendar_mutations()
returns table (failed_count integer, needs_repair_count integer, needs_repair_ids uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_failed integer;
  v_needs_repair integer;
  v_needs_repair_ids uuid[];
begin
  with expired as (
    update public.task_calendar_mutations
    set phase = case
          when phase = 'provider_done' then 'needs_repair'
          when phase = 'pending'
               and result_reason in ('no_token_stale_event', 'pref_disabled_stale_event')
            then 'needs_repair'
          else 'failed'
        end,
        result_reason = case
          when phase = 'provider_done' then 'finalize_needs_repair'
          when phase = 'pending'
               and result_reason in ('no_token_stale_event', 'pref_disabled_stale_event')
            then result_reason
          else 'retries_exhausted'
        end,
        updated_at = now()
    where operation in ('create', 'reschedule', 'reassign', 'cancel')
      and phase in ('pending', 'provider_done')
      and phase <> 'finalized'
      and attempts >= 5
      and next_attempt_at <= now()
    returning id, phase as new_phase
  )
  select
    count(*) filter (where new_phase = 'failed'),
    count(*) filter (where new_phase = 'needs_repair'),
    array_agg(id) filter (where new_phase = 'needs_repair')
  into v_failed, v_needs_repair, v_needs_repair_ids
  from expired;

  return query select
    coalesce(v_failed, 0),
    coalesce(v_needs_repair, 0),
    coalesce(v_needs_repair_ids, array[]::uuid[]);
end;
$$;

comment on function public.fn_expire_exhausted_calendar_mutations() is
  'PR 3 rename+widening of fn_expire_exhausted_calendar_creations to cover every ledger operation, not just create — a stuck reschedule/reassign/cancel row would otherwise hold its chain-serialization slot open forever with no exhaustion path at all. Same failed/needs_repair split and rationale as PR 2, PLUS (Codex round 1, finding 4): a still-pending row whose result_reason is no_token_stale_event/pref_disabled_stale_event (a KNOWN Google event the worker could not reconcile before ever calling Google) also routes to needs_repair, not failed — freeing the chain slot over a genuinely unreconciled event would be wrong.';

revoke all on function public.fn_expire_exhausted_calendar_mutations() from public, anon, authenticated;
grant execute on function public.fn_expire_exhausted_calendar_mutations() to service_role;

commit;
