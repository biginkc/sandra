-- 20261008143600_consent_unavailable_pause.sql
-- Messages v2: a distinct, resumable pause reason for a drip whose texting
-- permission could not be confirmed.
--
-- 1. pause_reason is free text (no CHECK/enum), so `consent_unavailable` needs
--    no constraint change. The tick pauses with it after 12 consecutive
--    consent-check failures on one step. No text was attempted (the claim is
--    already retired as not_attempted), so plain resume is correct;
--    `resume_sequence_enrollment` already lets it through (it is not in the
--    retry_required list) and this migration makes that explicit and adds the
--    budget reset below.
-- 2. resume_sequence_enrollment (patched forward from 20261002120000, same
--    signature and grants): on a successful resume, relabel the enrollment's
--    'consent_unavailable_deferred' step-run rows to
--    'consent_unavailable_resumed' so an earlier outage never counts toward the
--    next cap.
-- 3. ai_reply_dead_letters.resolution_reason: why the late-send sweeper stamped
--    resolved_at ('unreconcilable:*'); null = reconciled. service_role gets
--    UPDATE on it alongside resolved_at. Guarded so it is a no-op on a database
--    that does not yet have the table.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.ai_reply_dead_letters') is not null then
    alter table public.ai_reply_dead_letters add column if not exists resolution_reason text;
    comment on column public.ai_reply_dead_letters.resolution_reason is
      'Why resolved_at was stamped by the late-send sweeper: unreconcilable:missing_ids | unreconcilable:reply_failed | unreconcilable:no_reply. Null with resolved_at set = reconciled (sent_late marker exists).';
    grant update (resolution_reason) on table public.ai_reply_dead_letters to service_role;
  end if;
end $$;

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
  -- consent_unavailable is deliberately NOT in this list: the tick retired the
  -- claim as not_attempted before pausing (no text was attempted), so a plain
  -- resume is the correct and only recovery.
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

  -- A new consent-check budget starts at every resume: relabel this
  -- enrollment's deferred consent_unavailable rows so the tick's consecutive
  -- count (which counts only 'consent_unavailable_deferred') ignores them.
  update public.sequence_step_runs
     set recovery_action = 'consent_unavailable_resumed'
   where enrollment_id = e.id
     and recovery_action = 'consent_unavailable_deferred';

  update public.sequence_enrollments
     set status = 'active', pause_reason = null, next_run_at = next_at, updated_at = now()
   where id = e.id and status = 'paused';
  return query select 'resumed', next_at;
end;
$$;

revoke all on function public.resume_sequence_enrollment(uuid, uuid, text) from public, anon;
grant execute on function public.resume_sequence_enrollment(uuid, uuid, text) to authenticated, service_role;

commit;
