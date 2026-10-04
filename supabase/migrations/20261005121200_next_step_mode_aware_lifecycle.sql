-- My Leads one-call close, P1a-core (1a.4b): mode-aware appointment lifecycle.
--
-- Function definitions only. NO data step: nothing here changes an existing row.
-- A phone appointment never creates or moves a Google event; an in-person appointment
-- behaves exactly as before. An event that already exists on a phone row (relabeled legacy
-- row, or a row switched to phone) is removed through the normal reconciliation path: one
-- pending `cancel` ledger row carrying the old event_id. Otherwise a `finalized`-phase audit
-- row is written (the sweep claims only pending/provider_done, and the chain-serialization
-- unique index covers only pending/provider_done/needs_repair, so it never blocks) so keyed
-- replays and the public wrappers still find their row.
-- Each body is the latest live definition with only the stated diff:
--   fn_reschedule_appointment_base_20260816  (20261005121000 body): ledger insert by mode.
--   fn_reassign_appointment_base_20260816    (20260814210000 body): ledger insert by mode.
--   fn_cancel_appointment                    (20260816090000 body): finalized row for a
--                                             phone row with no event.
--   fn_book_appointment (20260816093000 wrapper): after the base insert it sets mode='in_person'
--   on the booked task (legacy booking always creates a Google create row).
--   fn_reschedule_appointment / fn_reassign_appointment (20260816093000 wrappers): return the
--   pending cancel row's id when one was queued in the same transaction, else the audit row's
--   id (a kick on a finalized row claims nothing); the 'ledger row missing' guard is kept.
-- Grants are re-asserted exactly as the originals set them.
begin;

create or replace function public.fn_reschedule_appointment_base_20260816(
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
  v_old_generation integer;
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
  where id = p_task
  returning calendar_generation into v_old_generation;

  insert into public.tasks (
    org_id, assignee_id, related_property_id, contact_id,
    type, status, title, description,
    due_at, end_at, calendar_chain_id, created_by, booking_idempotency_key, mode, location
  ) values (
    v_task.org_id, v_task.assignee_id, v_task.related_property_id, v_task.contact_id,
    'appointment', 'open', v_task.title, v_task.description,
    p_new_start, p_new_end, v_task.calendar_chain_id, v_actor, p_idempotency_key, v_task.mode, v_task.location
  )
  returning id into v_successor_id;

  -- expected_generation = 0: the successor's OWN generation, fresh off the
  -- default — an entirely different row/generation pair than the old row's
  -- just-bumped value. event_id is the OLD row's event (captured before the
  -- close above changed nothing about that column — it is never touched by
  -- this RPC, only read).
  if v_task.mode = 'in_person' then
    insert into public.task_calendar_mutations (
      org_id, calendar_chain_id, operation, phase,
      source_task_id, target_task_id, old_assignee_id, event_id, expected_generation
    ) values (
      v_task.org_id, v_task.calendar_chain_id, 'reschedule', 'pending',
      p_task, v_successor_id, v_task.assignee_id, v_task.google_calendar_event_id, 0
    )
    returning id into v_ledger_id;
  else
    -- Phone appointment: never create or move a Google event. The successor gets none.
    -- A finalized reschedule row is the audit/replay record the public wrapper finds (the
    -- sweep claims only pending/provider_done, so it never touches it).
    insert into public.task_calendar_mutations (
      org_id, calendar_chain_id, operation, phase,
      source_task_id, target_task_id, old_assignee_id, event_id, expected_generation,
      result_reason
    ) values (
      v_task.org_id, v_task.calendar_chain_id, 'reschedule', 'finalized',
      p_task, v_successor_id, v_task.assignee_id, null, 0,
      'phone_no_calendar'
    )
    returning id into v_ledger_id;
    -- An event that already exists on the old row (relabeled legacy row, or a row switched
    -- to phone) is removed through the normal reconciliation path: one pending cancel row.
    if v_task.google_calendar_event_id is not null then
      insert into public.task_calendar_mutations (
        org_id, calendar_chain_id, operation, phase,
        source_task_id, old_assignee_id, event_id, expected_generation
      ) values (
        v_task.org_id, v_task.calendar_chain_id, 'cancel', 'pending',
        p_task, v_task.assignee_id, v_task.google_calendar_event_id, v_old_generation
      );
    end if;
  end if;

  return jsonb_build_object(
    'task_id', v_successor_id,
    'old_task_id', p_task,
    'calendar_chain_id', v_task.calendar_chain_id,
    'duplicate', false
  );
end;
$$;

create or replace function public.fn_reassign_appointment_base_20260816(
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

  if v_task.mode = 'in_person' then
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

  else
    -- Phone appointment: no Google event is ever created. The reassign row is born finalized
    -- (audit + keyed-replay record; the sweep never claims it), so replay and the A->B->A
    -- protection still find it by reassign_idempotency_key.
    insert into public.task_calendar_mutations (
      org_id, calendar_chain_id, operation, phase,
      source_task_id, old_assignee_id, new_assignee_id, event_id, expected_generation,
      reassign_idempotency_key, result_reason
    ) values (
      v_task.org_id, v_task.calendar_chain_id, 'reassign', 'finalized',
      p_task, v_old_assignee, p_new_assignee, null, v_new_generation,
      p_idempotency_key, 'phone_no_calendar'
    )
    returning id into v_ledger_id;
    -- An event that already exists is removed with one pending cancel row (deleted under the
    -- old assignee's account); no create half.
    if v_old_event_id is not null then
      insert into public.task_calendar_mutations (
        org_id, calendar_chain_id, operation, phase,
        source_task_id, old_assignee_id, new_assignee_id, event_id, expected_generation
      ) values (
        v_task.org_id, v_task.calendar_chain_id, 'cancel', 'pending',
        p_task, v_old_assignee, p_new_assignee, v_old_event_id, v_new_generation
      );
    end if;
  end if;

  return jsonb_build_object(
    'task_id', p_task,
    'old_assignee_id', v_old_assignee,
    'new_assignee_id', p_new_assignee,
    'duplicate', false
  );
end;
$$;

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

  if v_task.mode = 'phone' and v_task.google_calendar_event_id is null then
    -- Phone appointment with no Google event: nothing to delete. Keep one finalized row for
    -- replay symmetry; the sweep never claims it and the returned ledger_id is a no-op kick.
    insert into public.task_calendar_mutations (
      org_id, calendar_chain_id, operation, phase,
      source_task_id, old_assignee_id, event_id, expected_generation, result_reason
    ) values (
      v_task.org_id, v_task.calendar_chain_id, 'cancel', 'finalized',
      p_task, v_task.assignee_id, null, v_new_generation, 'phone_no_calendar'
    )
    returning id into v_ledger_id;
  else
    insert into public.task_calendar_mutations (
      org_id, calendar_chain_id, operation, phase,
      source_task_id, old_assignee_id, event_id, expected_generation
    ) values (
      v_task.org_id, v_task.calendar_chain_id, 'cancel', 'pending',
      p_task, v_task.assignee_id, v_task.google_calendar_event_id, v_new_generation
    )
    returning id into v_ledger_id;
  end if;

  return jsonb_build_object(
    'task_id', p_task,
    'status', 'cancelled',
    'ledger_id', v_ledger_id
  );
end;
$$;

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
  v_result jsonb;
  v_ledger_id uuid;
  v_created_at timestamptz;
begin
  v_result := public.fn_reschedule_appointment_base_20260816(
    p_task, p_new_start, p_new_end, p_timezone, p_idempotency_key
  );

  -- The successor/source pair uniquely identifies the reschedule intent.
  -- A keyed replay returns that same successor and therefore the same id.
  select m.id, m.created_at into v_ledger_id, v_created_at
  from public.task_calendar_mutations m
  where m.operation = 'reschedule'
    and m.source_task_id = (v_result ->> 'old_task_id')::uuid
    and m.target_task_id = (v_result ->> 'task_id')::uuid;

  -- A phone reschedule leaves a finalized audit row; when the old row carried a Google
  -- event it also queued one pending cancel row (same transaction, same created_at).
  -- Prefer that pending row so the inline kick works it; the audit id otherwise (a kick on
  -- a finalized row claims nothing).
  if v_ledger_id is not null then
    select c.id into v_ledger_id
    from (
      select c0.id, 0 as pref
      from public.task_calendar_mutations c0
      where c0.operation = 'cancel' and c0.phase = 'pending'
        and c0.source_task_id = (v_result ->> 'old_task_id')::uuid
        and c0.created_at = v_created_at
      union all
      select v_ledger_id, 1
    ) c
    order by c.pref
    limit 1;
  end if;

  if v_ledger_id is null then
    raise exception 'fn_reschedule_appointment: exact calendar ledger row missing'
      using errcode = 'P0001';
  end if;
  return v_result || jsonb_build_object('ledger_id', v_ledger_id);
end;
$$;

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
  v_result jsonb;
  v_ledger_id uuid;
  v_created_at timestamptz;
begin
  v_result := public.fn_reassign_appointment_base_20260816(
    p_task, p_new_assignee, p_idempotency_key
  );

  if p_idempotency_key is not null then
    -- The persisted key is the authoritative replay identity, even after
    -- later A->B->A mutations on this same task.
    select m.id into v_ledger_id
    from public.task_calendar_mutations m
    where m.operation = 'reassign'
      and m.org_id = (
        select t.org_id from public.tasks t where t.id = p_task
      )
      and m.reassign_idempotency_key = p_idempotency_key;
  else
    -- The private implementation holds the task row lock until this wrapper
    -- transaction ends, so no later reassign can interleave before this
    -- immediate lookup. Match the full result and take the row just inserted.
    select m.id into v_ledger_id
    from public.task_calendar_mutations m
    where m.operation = 'reassign'
      and m.source_task_id = (v_result ->> 'task_id')::uuid
      and m.old_assignee_id = (v_result ->> 'old_assignee_id')::uuid
      and m.new_assignee_id = (v_result ->> 'new_assignee_id')::uuid
    order by m.created_at desc, m.id desc
    limit 1;
  end if;

  -- A phone reassign leaves a finalized reassign row; when an event existed it also queued
  -- one pending cancel row in the same transaction. Prefer that pending row for the kick.
  if v_ledger_id is not null then
    select m.created_at into v_created_at
    from public.task_calendar_mutations m where m.id = v_ledger_id;
    select c.id into v_ledger_id
    from (
      select c0.id, 0 as pref
      from public.task_calendar_mutations c0
      where c0.operation = 'cancel' and c0.phase = 'pending'
        and c0.source_task_id = p_task
        and c0.created_at = v_created_at
      union all
      select v_ledger_id, 1
    ) c
    order by c.pref
    limit 1;
  end if;

  if v_ledger_id is null then
    raise exception 'fn_reassign_appointment: exact calendar ledger row missing'
      using errcode = 'P0001';
  end if;
  return v_result || jsonb_build_object('ledger_id', v_ledger_id);
end;
$$;

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
  v_result jsonb;
  v_ledger_id uuid;
begin
  v_result := public.fn_book_appointment_base_20260816(
    p_org, p_assignee, p_start, p_end, p_timezone, p_title,
    p_contact, p_property, p_description, p_idempotency_key
  );

  -- A task has exactly one create intent, so this is exact for both the fresh
  -- path and every sequential/concurrent idempotency replay.
  select m.id into v_ledger_id
  from public.task_calendar_mutations m
  where m.org_id = p_org
    and m.operation = 'create'
    and m.source_task_id = (v_result ->> 'task_id')::uuid;

  -- Legacy booking always writes a Google create ledger row, so the appointment is
  -- in-person by meaning. Phone is the column default; mode is not lifecycle-guarded.
  update public.tasks
  set mode = 'in_person'
  where id = (v_result ->> 'task_id')::uuid
    and org_id = p_org
    and mode <> 'in_person';

  if v_ledger_id is null then
    raise exception 'fn_book_appointment: exact calendar ledger row missing'
      using errcode = 'P0001';
  end if;
  return v_result || jsonb_build_object('ledger_id', v_ledger_id);
end;
$$;

revoke all on function public.fn_reschedule_appointment_base_20260816(uuid,timestamptz,timestamptz,text,uuid)
  from public, anon, authenticated;
revoke all on function public.fn_reassign_appointment_base_20260816(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.fn_reschedule_appointment(uuid,timestamptz,timestamptz,text,uuid)
  from public, anon;
grant execute on function public.fn_reschedule_appointment(uuid,timestamptz,timestamptz,text,uuid)
  to authenticated;
revoke all on function public.fn_reassign_appointment(uuid,uuid,uuid)
  from public, anon;
grant execute on function public.fn_reassign_appointment(uuid,uuid,uuid)
  to authenticated;
revoke all on function public.fn_cancel_appointment(uuid) from public, anon;
grant execute on function public.fn_cancel_appointment(uuid) to authenticated;
revoke all on function public.fn_book_appointment(uuid,uuid,timestamptz,timestamptz,text,text,uuid,uuid,text,uuid)
  from public, anon;
grant execute on function public.fn_book_appointment(uuid,uuid,timestamptz,timestamptz,text,text,uuid,uuid,text,uuid)
  to authenticated;

commit;
