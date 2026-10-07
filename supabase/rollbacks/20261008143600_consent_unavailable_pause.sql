-- Rollback for 20261008143600_consent_unavailable_pause. Restores the previous
-- resume_sequence_enrollment body (from 20261002120000) and drops the
-- resolution_reason column. Paused consent_unavailable enrollments keep their
-- reason; plain resume still works on them with the restored body.
begin;

create or replace function public.resume_sequence_enrollment(
  p_enrollment_id uuid,
  p_actor_user_id uuid default null,
  p_expected_pause_reason text default null
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
  -- [I1] The caller decided to resume based on a read of the pause reason. A
  -- reply, takeover or Norma conversion may have changed it since.
  if p_expected_pause_reason is not null
     and e.pause_reason is distinct from p_expected_pause_reason then
    return query select 'pause_reason_changed', e.next_run_at;
    return;
  end if;
  -- [G2] An open Norma request holds every enrollment on the property.
  if public.fn_norma_hold_active(e.property_id) then
    return query select 'norma_hold', e.next_run_at;
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

revoke all on function public.resume_sequence_enrollment(uuid, uuid, text) from public, anon;
grant execute on function public.resume_sequence_enrollment(uuid, uuid, text) to authenticated, service_role;

do $$
begin
  if to_regclass('public.ai_reply_dead_letters') is not null then
    revoke update (resolution_reason) on table public.ai_reply_dead_letters from service_role;
    alter table public.ai_reply_dead_letters drop column if exists resolution_reason;
  end if;
end $$;

commit;
