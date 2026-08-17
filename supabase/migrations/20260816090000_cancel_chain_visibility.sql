-- Preserve appointment lifecycle history while keeping terminally-cancelled
-- reschedule chains off Calendar read surfaces.
--
-- A reschedule predecessor is an immutable audit row: completed/rescheduled
-- records when and by whom the original slot was closed. Cancelling the open
-- successor must not rewrite that history (and DNC-locked history cannot be
-- rewritten at all). Calendar queries instead suppress such a predecessor at
-- read time when a cancelled row exists in the same organization and chain.

begin;

-- Supports the anti-join used by fn_calendar_month_appointments. The org key
-- is mandatory: calendar_chain_id is lineage, not a cross-tenant identifier.
create index if not exists idx_tasks_cancelled_appointment_chain
  on public.tasks (org_id, calendar_chain_id)
  where type = 'appointment' and status = 'cancelled';

-- Restore the lifecycle contract from 20260814210000: only the open target is
-- cancelled. The org predicate on the active-mutation guard is an additional
-- tenant-safety hardening; no predecessor task is mutated or backfilled.
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

  insert into public.task_calendar_mutations (
    org_id, calendar_chain_id, operation, phase,
    source_task_id, old_assignee_id, event_id, expected_generation
  ) values (
    v_task.org_id, v_task.calendar_chain_id, 'cancel', 'pending',
    p_task, v_task.assignee_id, v_task.google_calendar_event_id, v_new_generation
  )
  returning id into v_ledger_id;

  return jsonb_build_object(
    'task_id', p_task,
    'status', 'cancelled',
    'ledger_id', v_ledger_id
  );
end;
$$;

comment on function public.fn_cancel_appointment(uuid) is
  'Cancels only the requested open appointment and opens its exact cancel/pending ledger row. Completed/rescheduled predecessors remain immutable audit history and are suppressed only by Calendar reads when the chain has a cancelled successor.';

revoke all on function public.fn_cancel_appointment(uuid) from public, anon;
grant execute on function public.fn_cancel_appointment(uuid) to authenticated;

commit;
