-- 20261021130000_voicemail_drop_record_outcome.sql
-- Voicemail drop PR 3: the worker records the POST answer in ONE transaction.
--
-- record_voicemail_drop_accepted (202) and record_voicemail_drop_unknown
-- (502 / timeout / network) replace the worker's separate run, drop and
-- enrollment writes. Each locks enrollment -> step run -> drop row (the
-- authorize_sequence_provider_attempt / fn_norma_lock_lead order) and
-- re-checks under the locks, so a Drop Cowboy status event that lands at the
-- same moment either sees the worker's whole write or none of it.
--
-- Only the transition that flips the run unknown -> accepted (the owner)
-- advances the enrollment. voicemail_drop_settle_enrollment is that shared
-- advance; the status-event resolver (20261021140000) reuses it.
--
-- Additive: three new functions, no table change. Rollback:
-- supabase/rollbacks/20261021130000_voicemail_drop_record_outcome.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Settle the enrollment after a drop on step p_step_index was proven queued.
-- The caller already holds the enrollment row lock (select ... for update).
--   p_eligible     caller owns the unknown -> accepted flip, or the
--                  enrollment is paused reconciliation_required on this step
--                  with the run already accepted.
--   p_pause_reason consent / misconfigured pause required by the outcome.
-- Returns advanced | completed | advanced_paused | paused | none.
create or replace function public.voicemail_drop_settle_enrollment(
  p_enrollment_id uuid,
  p_step_index integer,
  p_eligible boolean,
  p_pause_reason text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments%rowtype;
  next_delay integer;
  has_next boolean;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if e.id is null then
    return 'none';
  end if;

  if not p_eligible then
    -- Not the owner: never moves the pointer, only the reason. A required
    -- pause stops an active enrollment and replaces a temporary pause
    -- (call_in_progress / norma_call / reconciliation_required), so a call
    -- ending or a later drop's reconcile cannot reactivate the drip. Consent
    -- also replaces a real stop reason; step_misconfigured keeps it.
    if p_pause_reason is not null and (
      e.status = 'active'
      or (e.status = 'paused' and e.pause_reason is distinct from p_pause_reason and (
        p_pause_reason = 'voicemail_drop_consent_blocked'
        or e.pause_reason in ('call_in_progress', 'norma_call', 'reconciliation_required')
      ))
    ) then
      update public.sequence_enrollments
         set status = 'paused', pause_reason = p_pause_reason, updated_at = now()
       where id = e.id;
      return 'paused';
    end if;
    return 'none';
  end if;

  -- Cancelled / opted out / completed, or already moved off this step.
  if e.status not in ('active', 'paused') or e.current_step_index <> p_step_index then
    return 'none';
  end if;

  select st.delay_after_previous_minutes, true into next_delay, has_next
    from public.sequence_steps st
   where st.sequence_id = e.sequence_id and st.step_index = p_step_index + 1;
  has_next := coalesce(has_next, false);

  if p_pause_reason is not null then
    -- Pause required: never active, pointer moves past the drop.
    if has_next then
      update public.sequence_enrollments
         set status = 'paused', pause_reason = p_pause_reason,
             current_step_index = p_step_index + 1,
             next_run_at = now() + make_interval(mins => next_delay),
             updated_at = now()
       where id = e.id;
      return 'advanced_paused';
    end if;
    update public.sequence_enrollments
       set status = 'completed', pause_reason = p_pause_reason,
           completed_at = now(), next_run_at = null, updated_at = now()
     where id = e.id;
    return 'completed';
  end if;

  if e.status = 'active' or e.pause_reason = 'reconciliation_required' then
    if has_next then
      update public.sequence_enrollments
         set status = 'active', pause_reason = null,
             current_step_index = p_step_index + 1,
             next_run_at = now() + make_interval(mins => next_delay),
             updated_at = now()
       where id = e.id;
      return 'advanced';
    end if;
    update public.sequence_enrollments
       set status = 'completed', pause_reason = null,
           completed_at = now(), next_run_at = null, updated_at = now()
     where id = e.id;
    return 'completed';
  end if;

  -- Paused for another reason (reply, call-back, takeover...): advance in
  -- place and keep that reason, as if the 202 had arrived before the stop.
  if has_next then
    update public.sequence_enrollments
       set current_step_index = p_step_index + 1,
           next_run_at = now() + make_interval(mins => next_delay),
           updated_at = now()
     where id = e.id;
    return 'advanced_paused';
  end if;
  update public.sequence_enrollments
     set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now()
   where id = e.id;
  return 'completed';
end;
$$;
revoke all on function public.voicemail_drop_settle_enrollment(uuid, integer, boolean, text)
  from public, anon, authenticated, service_role;

-- 202: the POST queued the drop.
-- Returns advanced | completed | advanced_paused | paused | none (owner),
-- already_settled (run was already accepted) or run_changed (claim released
-- or the run moved to another outcome; nothing written).
create or replace function public.record_voicemail_drop_accepted(
  p_run_id uuid,
  p_drop_row_id uuid,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enrollment uuid;
  r public.sequence_step_runs%rowtype;
  d public.voicemail_drops%rowtype;
  v_step_index integer;
begin
  -- Unlocked read for the enrollment id, then lock in the shared order.
  select sr.enrollment_id into v_enrollment from public.sequence_step_runs sr where sr.id = p_run_id;
  if v_enrollment is null then
    return 'run_changed';
  end if;
  perform 1 from public.sequence_enrollments where id = v_enrollment for update;
  select * into r from public.sequence_step_runs where id = p_run_id for update;
  select * into d from public.voicemail_drops where id = p_drop_row_id and step_run_id = p_run_id for update;
  if d.id is null or not r.claim_active or r.attempt_outcome not in ('unknown', 'accepted') then
    return 'run_changed';
  end if;

  if r.attempt_outcome = 'accepted' then
    -- A status event already owned the flip. Store the 202 payload only while
    -- the drop is still queued; a terminal outcome keeps its own payload.
    update public.voicemail_drops
       set provider_payload = p_payload, attempt_outcome = 'queued',
           queued_at = coalesce(queued_at, now())
     where id = d.id and status = 'queued';
    return 'already_settled';
  end if;

  update public.sequence_step_runs
     set attempt_outcome = 'accepted', run_at = now(), message_id = null, failure_reason = null
   where id = r.id;
  if d.status = 'queued' then
    update public.voicemail_drops
       set attempt_outcome = 'queued', queued_at = coalesce(queued_at, now()), provider_payload = p_payload
     where id = d.id;
  else
    update public.voicemail_drops set attempt_outcome = 'queued' where id = d.id;
  end if;

  select st.step_index into v_step_index from public.sequence_steps st where st.id = r.step_id;
  if v_step_index is null then
    return 'none';
  end if;
  return public.voicemail_drop_settle_enrollment(v_enrollment, v_step_index, true, null);
end;
$$;
revoke all on function public.record_voicemail_drop_accepted(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_voicemail_drop_accepted(uuid, uuid, jsonb) to service_role;

-- 502 / timeout / network: the drop may or may not be queued.
-- Returns held (run kept unknown, enrollment paused reconciliation_required
-- if it was still active on this step), already_reconciled (a status event
-- already accepted the run and advanced the enrollment; nothing written) or
-- run_changed.
create or replace function public.record_voicemail_drop_unknown(
  p_run_id uuid,
  p_drop_row_id uuid,
  p_reason text,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enrollment uuid;
  e public.sequence_enrollments%rowtype;
  r public.sequence_step_runs%rowtype;
  d public.voicemail_drops%rowtype;
  v_step_index integer;
begin
  select sr.enrollment_id into v_enrollment from public.sequence_step_runs sr where sr.id = p_run_id;
  if v_enrollment is null then
    return 'run_changed';
  end if;
  select * into e from public.sequence_enrollments where id = v_enrollment for update;
  select * into r from public.sequence_step_runs where id = p_run_id for update;
  select * into d from public.voicemail_drops where id = p_drop_row_id and step_run_id = p_run_id for update;
  if r.attempt_outcome = 'accepted' and r.claim_active then
    return 'already_reconciled';
  end if;
  if d.id is null or not r.claim_active or r.attempt_outcome <> 'unknown' then
    return 'run_changed';
  end if;

  update public.sequence_step_runs
     set run_at = now(), skipped_reason = 'provider_failed', failure_reason = p_reason
   where id = r.id;
  update public.voicemail_drops
     set reason = p_reason, provider_payload = p_payload
   where id = d.id and attempt_outcome = 'unknown' and status = 'queued';

  select st.step_index into v_step_index from public.sequence_steps st where st.id = r.step_id;
  if e.status = 'active' and e.current_step_index = v_step_index then
    update public.sequence_enrollments
       set status = 'paused', pause_reason = 'reconciliation_required', updated_at = now()
     where id = e.id;
  end if;
  return 'held';
end;
$$;
revoke all on function public.record_voicemail_drop_unknown(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_voicemail_drop_unknown(uuid, uuid, text, jsonb) to service_role;

commit;
