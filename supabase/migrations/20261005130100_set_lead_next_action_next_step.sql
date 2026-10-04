-- My Leads one-call close, P1a-writers (1a.7): the board quick "next action" writes through
-- fn_create_next_step. Same signature, return shape, security invoker and search_path as
-- 20260815233000; two changes: the replay check accepts the relabeled kind (a key issued
-- before the relabel now resolves to an appointment), and the insert becomes an appointment
-- created by fn_create_next_step (phone, 15 minutes, window enforced for a browser caller).
begin;

create or replace function public.set_lead_next_action(
  p_property_id uuid,
  p_due_at timestamptz,
  p_idempotency_key uuid
)
returns table (
  id uuid,
  org_id uuid,
  assignee_id uuid,
  related_property_id uuid,
  type text,
  status text,
  title text,
  due_at timestamptz,
  created_by uuid,
  created_at timestamptz,
  was_created boolean
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  lead_row public.properties%rowtype;
  task_row public.tasks%rowtype;
  new_task_id uuid;
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED: Sign in to set a next action';
  end if;
  if p_due_at is null then
    raise exception using errcode = '22007', message = 'INVALID_DUE_AT: Choose a valid due date';
  end if;
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED: Retry token is required';
  end if;

  -- Tenant authorization is checked before replay, while mutable lead state
  -- is deliberately checked afterward. A committed request can therefore be
  -- faithfully replayed even if DNC/deletion changed after its response was
  -- lost.
  select p.* into lead_row
  from public.properties p
  where p.id = p_property_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND: Lead not found';
  end if;
  if not exists (
    select 1 from public.memberships membership
    where membership.org_id = lead_row.org_id
      and membership.user_id = actor_id
  ) then
    raise exception using errcode = '42501', message = 'LEAD_FORBIDDEN: You do not have access to this lead';
  end if;

  select t.* into task_row
  from public.tasks t
  where t.org_id = lead_row.org_id
    and t.lead_next_action_idempotency_key = p_idempotency_key;
  if found then
    if task_row.related_property_id is distinct from lead_row.id
      or task_row.created_by is distinct from actor_id
      or task_row.next_step_kind <> 'appointment'
      or task_row.due_at is distinct from p_due_at
    then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_CONFLICT: Retry token belongs to a different request';
    end if;
    return query select task_row.id, task_row.org_id, task_row.assignee_id,
      task_row.related_property_id, task_row.type, task_row.status,
      task_row.title, task_row.due_at, task_row.created_by,
      task_row.created_at, false;
    return;
  end if;

  -- Serialize new attempts for one lead. DNC ratcheting uses the same
  -- property row, so either the lock wins or the task creation wins.
  select p.* into lead_row
  from public.properties p
  where p.id = p_property_id
  for no key update;

  if not found or lead_row.deleted_at is not null then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND: Lead not found';
  end if;
  if lead_row.is_dnc_locked then
    raise exception using errcode = 'P0001', message = 'DNC_LOCKED: This lead is permanently read-only';
  end if;
  if lead_row.status = 'prospect' then
    raise exception using errcode = '22023', message = 'NOT_A_LEAD: Promote this prospect before setting a lead action';
  end if;

  select t.* into task_row
  from public.tasks t
  where t.org_id = lead_row.org_id
    and t.related_property_id = lead_row.id
    and t.status = 'open'
  order by t.due_at asc, t.id asc
  limit 1;
  if found then
    return query select task_row.id, task_row.org_id, task_row.assignee_id,
      task_row.related_property_id, task_row.type, task_row.status,
      task_row.title, task_row.due_at, task_row.created_by,
      task_row.created_at, false;
    return;
  end if;

  -- The one write path. A browser caller must enforce the booking window (past by at most an
  -- hour, at most two years out); the retry token rides on the task as before.
  -- Two statements on purpose: a row inserted by a function called inside a query is not
  -- visible to that same query's snapshot.
  new_task_id := (public.fn_create_next_step(
    p_org := lead_row.org_id, p_actor := actor_id, p_assignee := actor_id, p_kind := 'appointment',
    p_title := 'Follow up on ' || lead_row.address, p_due_at := p_due_at,
    p_property := lead_row.id, p_contact := lead_row.homeowner_contact_id,
    p_lead_next_action_key := p_idempotency_key, p_origin := 'board',
    p_enforce_window := true) ->> 'task_id')::uuid;
  select t.* into task_row from public.tasks t where t.id = new_task_id;

  return query select task_row.id, task_row.org_id, task_row.assignee_id,
    task_row.related_property_id, task_row.type, task_row.status,
    task_row.title, task_row.due_at, task_row.created_by,
    task_row.created_at, true;
end;
$$;

revoke all on function public.set_lead_next_action(uuid, timestamptz, uuid) from public;
grant execute on function public.set_lead_next_action(uuid, timestamptz, uuid)
  to authenticated, service_role;

commit;
