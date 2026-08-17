-- Inline Calendar synchronization must claim the exact durable intent created
-- by the user action. Task-scoped "newest pending row" lookup is unsafe: a
-- delayed request can otherwise spend an attempt on a later mutation for the
-- same appointment. These wrappers attach the transaction's exact ledger id
-- to every mutation-producing lifecycle result, including keyed replays.

begin;

-- Keep the already-reviewed lifecycle implementations intact behind private
-- names. This migration is re-applicable in development: rename only once.
do $$
begin
  if to_regprocedure('public.fn_book_appointment_base_20260816(uuid,uuid,timestamptz,timestamptz,text,text,uuid,uuid,text,uuid)') is null then
    alter function public.fn_book_appointment(uuid,uuid,timestamptz,timestamptz,text,text,uuid,uuid,text,uuid)
      rename to fn_book_appointment_base_20260816;
  end if;
  if to_regprocedure('public.fn_reschedule_appointment_base_20260816(uuid,timestamptz,timestamptz,text,uuid)') is null then
    alter function public.fn_reschedule_appointment(uuid,timestamptz,timestamptz,text,uuid)
      rename to fn_reschedule_appointment_base_20260816;
  end if;
  if to_regprocedure('public.fn_reassign_appointment_base_20260816(uuid,uuid,uuid)') is null then
    alter function public.fn_reassign_appointment(uuid,uuid,uuid)
      rename to fn_reassign_appointment_base_20260816;
  end if;
end
$$;

revoke all on function public.fn_book_appointment_base_20260816(uuid,uuid,timestamptz,timestamptz,text,text,uuid,uuid,text,uuid)
  from public, anon, authenticated;
revoke all on function public.fn_reschedule_appointment_base_20260816(uuid,timestamptz,timestamptz,text,uuid)
  from public, anon, authenticated;
revoke all on function public.fn_reassign_appointment_base_20260816(uuid,uuid,uuid)
  from public, anon, authenticated;

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

  if v_ledger_id is null then
    raise exception 'fn_book_appointment: exact calendar ledger row missing'
      using errcode = 'P0001';
  end if;
  return v_result || jsonb_build_object('ledger_id', v_ledger_id);
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
begin
  v_result := public.fn_reschedule_appointment_base_20260816(
    p_task, p_new_start, p_new_end, p_timezone, p_idempotency_key
  );

  -- The successor/source pair uniquely identifies the reschedule intent.
  -- A keyed replay returns that same successor and therefore the same id.
  select m.id into v_ledger_id
  from public.task_calendar_mutations m
  where m.operation = 'reschedule'
    and m.source_task_id = (v_result ->> 'old_task_id')::uuid
    and m.target_task_id = (v_result ->> 'task_id')::uuid;

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

  if v_ledger_id is null then
    raise exception 'fn_reassign_appointment: exact calendar ledger row missing'
      using errcode = 'P0001';
  end if;
  return v_result || jsonb_build_object('ledger_id', v_ledger_id);
end;
$$;

revoke all on function public.fn_book_appointment(uuid,uuid,timestamptz,timestamptz,text,text,uuid,uuid,text,uuid)
  from public, anon;
grant execute on function public.fn_book_appointment(uuid,uuid,timestamptz,timestamptz,text,text,uuid,uuid,text,uuid)
  to authenticated;
revoke all on function public.fn_reschedule_appointment(uuid,timestamptz,timestamptz,text,uuid)
  from public, anon;
grant execute on function public.fn_reschedule_appointment(uuid,timestamptz,timestamptz,text,uuid)
  to authenticated;
revoke all on function public.fn_reassign_appointment(uuid,uuid,uuid)
  from public, anon;
grant execute on function public.fn_reassign_appointment(uuid,uuid,uuid)
  to authenticated;

-- Same returned row as the global sweep, but the claim key is the exact
-- lifecycle-returned ledger id. There is no ORDER BY and no task fallback.
drop function if exists public.fn_claim_calendar_mutation_for_task(uuid);

create or replace function public.fn_claim_calendar_mutation_for_ledger(
  p_ledger_id uuid
)
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
  old_event_deleted_at timestamptz,
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
    update public.task_calendar_mutations mutation
    set attempts = mutation.attempts + 1,
        next_attempt_at = now() + interval '2 minutes',
        claim_token = gen_random_uuid(),
        updated_at = now()
    where mutation.id = p_ledger_id
      and mutation.phase in ('pending', 'provider_done')
      and mutation.attempts < 5
      and (mutation.next_attempt_at is null or mutation.next_attempt_at <= now())
    returning mutation.*
  )
  select
    claimed.id, claimed.org_id, claimed.calendar_chain_id,
    claimed.operation, claimed.phase, claimed.source_task_id,
    claimed.target_task_id, claimed.old_assignee_id,
    claimed.new_assignee_id, claimed.event_id, claimed.new_event_id,
    claimed.client_event_id, claimed.result_reason,
    claimed.old_event_deleted_at, claimed.expected_generation,
    claimed.attempts, claimed.claim_token,
    source_task.due_at, source_task.end_at, source_task.title,
    source_task.assignee_id,
    target_task.due_at, target_task.end_at, target_task.title,
    target_task.assignee_id
  from claimed
  join public.tasks source_task
    on source_task.id = claimed.source_task_id
   and source_task.org_id = claimed.org_id
   and source_task.calendar_chain_id = claimed.calendar_chain_id
  left join public.tasks target_task
    on target_task.id = claimed.target_task_id
   and target_task.org_id = claimed.org_id
   and target_task.calendar_chain_id = claimed.calendar_chain_id;
$$;

comment on function public.fn_claim_calendar_mutation_for_ledger(uuid) is
  'Service-role-only inline claim of one exact lifecycle-returned calendar ledger id. It cannot fall forward to a newer mutation on the same task.';

revoke all on function public.fn_claim_calendar_mutation_for_ledger(uuid)
  from public, anon, authenticated;
grant execute on function public.fn_claim_calendar_mutation_for_ledger(uuid)
  to service_role;

commit;
