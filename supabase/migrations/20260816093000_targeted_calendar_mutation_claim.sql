-- User-triggered appointment actions should advance only the ledger row they
-- just created. The global sweep claim intentionally remains oldest-first and
-- one-at-a-time; using it inline would burn attempts on unrelated backlog.

begin;

create or replace function public.fn_claim_calendar_mutation_for_task(
  p_source_task uuid
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
    from (
      select id
      from public.task_calendar_mutations
      where source_task_id = p_source_task
        and phase in ('pending', 'provider_done')
        and attempts < 5
        and (next_attempt_at is null or next_attempt_at <= now())
      order by created_at desc
      for update skip locked
      limit 1
    ) target
    where mutation.id = target.id
    returning
      mutation.id,
      mutation.org_id,
      mutation.calendar_chain_id,
      mutation.operation,
      mutation.phase,
      mutation.source_task_id,
      mutation.target_task_id,
      mutation.old_assignee_id,
      mutation.new_assignee_id,
      mutation.event_id,
      mutation.new_event_id,
      mutation.client_event_id,
      mutation.result_reason,
      mutation.old_event_deleted_at,
      mutation.expected_generation,
      mutation.attempts,
      mutation.claim_token
  )
  select
    claimed.id,
    claimed.org_id,
    claimed.calendar_chain_id,
    claimed.operation,
    claimed.phase,
    claimed.source_task_id,
    claimed.target_task_id,
    claimed.old_assignee_id,
    claimed.new_assignee_id,
    claimed.event_id,
    claimed.new_event_id,
    claimed.client_event_id,
    claimed.result_reason,
    claimed.old_event_deleted_at,
    claimed.expected_generation,
    claimed.attempts,
    claimed.claim_token,
    source_task.due_at,
    source_task.end_at,
    source_task.title,
    source_task.assignee_id,
    target_task.due_at,
    target_task.end_at,
    target_task.title,
    target_task.assignee_id
  from claimed
  join public.tasks source_task on source_task.id = claimed.source_task_id
  left join public.tasks target_task on target_task.id = claimed.target_task_id;
$$;

comment on function public.fn_claim_calendar_mutation_for_task(uuid) is
  'Service-role-only targeted claim for an inline appointment action. Claims at most the due pending/provider_done ledger row whose source_task_id exactly matches the action result, preserving the global sweep''s one-row anti-attempt-burn invariant and the existing SKIP LOCKED, two-minute lease, and claim-token fencing contracts.';

revoke all on function public.fn_claim_calendar_mutation_for_task(uuid)
  from public, anon, authenticated;
grant execute on function public.fn_claim_calendar_mutation_for_task(uuid)
  to service_role;

commit;
