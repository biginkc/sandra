-- Roll back norma_call_requests. Restores the two-argument
-- resume_sequence_enrollment from 20260919090000_sequence_runtime_recovery and
-- removes the Norma tables, functions and tasks.source_key. Run only when no
-- enrollment is paused with pause_reason = 'norma_call' (resume them first).
-- MUST ship together with a code revert: the stale-call sweep, the sequence
-- tick, resumeByProperty and the inbound reply path call the objects dropped
-- here (sweep_resume_call_in_progress, norma_call_requests, fn_norma_*).
begin;

drop function if exists public.sweep_resume_call_in_progress(uuid[], timestamptz);
drop function if exists public.fn_norma_upgrade_pauses_for_reply(uuid, text);
drop function if exists public.fn_norma_complete_call(uuid, text, text, jsonb);
drop function if exists public.fn_norma_mark_needs_review(uuid, text);
drop function if exists public.fn_norma_mark_dispatch_unknown(uuid, text);
drop function if exists public.fn_norma_mark_dispatch_rejected(uuid, text);
drop function if exists public.fn_norma_bind_call_id(uuid, text);
drop function if exists public.fn_norma_claim_dispatch(uuid);
drop function if exists public.fn_norma_create_request(uuid, uuid, text, uuid, text, uuid);
drop function if exists public.fn_norma_release_pauses(uuid);
drop function if exists public.fn_norma_pause_for_request(uuid);

drop function if exists public.resume_sequence_enrollment(uuid, uuid, text);
create or replace function public.resume_sequence_enrollment(
  p_enrollment_id uuid,
  p_actor_user_id uuid default null
)
returns table (outcome text, next_run_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments%rowtype;
  s public.sequence_steps%rowtype;
  r public.sequence_step_runs%rowtype;
  next_at timestamptz;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id for update;
  if e.id is null then
    return query select 'not_found', null::timestamptz;
    return;
  end if;
  if (coalesce(auth.role(), '') = 'service_role' and p_actor_user_id is not null)
     or (coalesce(auth.role(), '') <> 'service_role' and (
       auth.uid() is null
       or (p_actor_user_id is not null and p_actor_user_id <> auth.uid())
       or not exists (
         select 1 from public.memberships m
          where m.org_id = e.org_id and m.user_id = auth.uid()
       )
     )) then
    return query select 'not_authorized', null::timestamptz;
    return;
  end if;
  if e.status <> 'paused' then
    return query select 'not_paused', e.next_run_at;
    return;
  end if;
  if coalesce(e.pause_reason, '') in ('reconciliation_required', 'provider_failed') then
    return query select 'retry_required', e.next_run_at;
    return;
  end if;

  select * into s from public.sequence_steps
   where sequence_id = e.sequence_id and step_index = e.current_step_index;
  if s.id is not null then
    select * into r from public.sequence_step_runs
     where enrollment_id = e.id and step_id = s.id and claim_active
     order by created_at desc limit 1
     for update;
    if r.id is not null then
      if r.attempt_outcome not in ('not_attempted', 'definitively_rejected') then
        return query select 'reconciliation_required', e.next_run_at;
        return;
      end if;
      update public.sequence_step_runs
         set claim_active = false,
             recovery_actor_user_id = coalesce(p_actor_user_id, auth.uid()),
             recovery_action = 'resume',
             recovery_evidence = 'paused enrollment resumed with a proven no-attempt claim'
       where id = r.id and claim_active;
    end if;
    next_at := now() + make_interval(mins => s.delay_after_previous_minutes);
  else
    next_at := now();
  end if;

  update public.sequence_enrollments
     set status = 'active', pause_reason = null, next_run_at = next_at, updated_at = now()
   where id = e.id and status = 'paused';
  return query select 'resumed', next_at;
end;
$$;

revoke all on function public.resume_sequence_enrollment(uuid, uuid) from public, anon;
grant execute on function public.resume_sequence_enrollment(uuid, uuid) to authenticated, service_role;

drop table if exists public.norma_notifications;
drop table if exists public.norma_enrollment_pauses;
drop table if exists public.norma_call_requests;
drop function if exists public.norma_call_requests_guard();
drop function if exists public.fn_norma_eligibility(uuid, uuid, text);
drop function if exists public.fn_norma_hold_active(uuid);

drop index if exists public.idx_tasks_org_source_key;
alter table public.tasks drop column if exists source_key;

commit;
