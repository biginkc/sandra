-- 20261021140000_voicemail_drop_resolve_outcome.sql
-- Voicemail drop PR 4: a Drop Cowboy terminal outcome (callback or signed
-- contact.rvm.status) is applied in ONE transaction.
--
-- resolve_voicemail_drop_outcome replaces the separate reconcile / pause /
-- drop-status writes in status-updates.ts. Locks enrollment -> step run ->
-- drop row (the authorize_sequence_provider_attempt / fn_norma_lock_lead
-- order, same as record_voicemail_drop_* in 20261021130000) and re-checks:
--   * a drop still queued, or a replay of the same terminal state, whose run
--     is still 'unknown' makes this call the owner: run -> accepted, drop
--     attempt_outcome -> queued, enrollment settled by
--     voicemail_drop_settle_enrollment (advance, completed, or paused with the
--     required reason at the next step; never active when a pause is needed);
--   * an enrollment paused reconciliation_required on the drop's step with
--     the run already accepted is settled the same way;
--   * otherwise a required pause (consent / misconfigured) still pauses an
--     active enrollment, unless the drop already holds the other terminal
--     outcome (a late conflicting event changes nothing but facts).
-- If anything fails, nothing commits, so the webhook retry redoes all of it.
--
-- Additive: one new function, no table change. Rollback:
-- supabase/rollbacks/20261021140000_voicemail_drop_resolve_outcome.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.resolve_voicemail_drop_outcome(
  p_drop_row_id uuid,
  p_status text,
  p_pause_reason text,
  p_reason_code text,
  p_reason text,
  p_drop_id text,
  p_cost numeric,
  p_proof_url text,
  p_payload jsonb
)
returns table (drop_result text, enrollment_action text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enrollment uuid;
  v_run uuid;
  e public.sequence_enrollments%rowtype;
  r public.sequence_step_runs%rowtype;
  d public.voicemail_drops%rowtype;
  v_owner boolean := false;
  v_eligible boolean;
  v_step_index integer;
  v_result text;
  v_action text := 'none';
begin
  if p_status is null or p_status not in ('delivered', 'failed') then
    raise exception 'invalid voicemail drop outcome %', p_status using errcode = '22023';
  end if;
  if p_pause_reason is not null
     and p_pause_reason not in ('voicemail_drop_consent_blocked', 'step_misconfigured') then
    raise exception 'invalid voicemail drop pause reason %', p_pause_reason using errcode = '22023';
  end if;

  -- Unlocked read for the ids, then lock in the shared order and re-check.
  select vd.enrollment_id, vd.step_run_id into v_enrollment, v_run
    from public.voicemail_drops vd where vd.id = p_drop_row_id;
  if not found then
    return query select 'not_found'::text, 'none'::text;
    return;
  end if;
  if v_enrollment is not null then
    select * into e from public.sequence_enrollments where id = v_enrollment for update;
  end if;
  select * into r from public.sequence_step_runs where id = v_run for update;
  select * into d from public.voicemail_drops where id = p_drop_row_id for update;

  -- Owner: the drop was actually posted (queued, or a same-state replay) and
  -- the run is still waiting on the unknown POST answer.
  if d.status in ('queued', p_status) and d.attempt_outcome = 'unknown'
     and r.id is not null and r.claim_active and r.attempt_outcome = 'unknown' then
    update public.sequence_step_runs
       set attempt_outcome = 'accepted', skipped_reason = null, failure_reason = null,
           message_id = null, recovery_action = 'voicemail_drop_reconciled',
           recovery_evidence = 'Drop Cowboy sent a status event for this drop, so the unknown POST was queued'
     where id = r.id;
    update public.voicemail_drops
       set attempt_outcome = 'queued', queued_at = coalesce(queued_at, now())
     where id = d.id;
    r.attempt_outcome := 'accepted';
    v_owner := true;
  end if;

  if d.status = 'queued' then
    update public.voicemail_drops
       set status = p_status, reason_code = p_reason_code, reason = p_reason,
           completed_at = now(),
           drop_id = coalesce(drop_id, p_drop_id),
           cost = coalesce(p_cost, cost),
           proof_url = coalesce(p_proof_url, proof_url),
           provider_payload = coalesce(p_payload, provider_payload)
     where id = d.id;
    v_result := 'applied';
  else
    -- Same-state replay or a late conflicting outcome: keep the outcome, add
    -- only facts the row is missing or that only the provider knows.
    update public.voicemail_drops
       set drop_id = coalesce(drop_id, p_drop_id),
           cost = coalesce(p_cost, cost),
           proof_url = coalesce(p_proof_url, proof_url)
     where id = d.id;
    v_result := case when d.status = p_status then 'replay' else 'conflict' end;
  end if;

  if e.id is not null and r.id is not null and r.claim_active then
    select st.step_index into v_step_index from public.sequence_steps st where st.id = r.step_id;
    v_eligible := v_owner or (
      e.status = 'paused' and e.pause_reason = 'reconciliation_required'
      and e.current_step_index = v_step_index and r.attempt_outcome = 'accepted'
    );
    if v_step_index is not null and v_eligible then
      -- Consent replaces an existing stop reason; step_misconfigured keeps a
      -- real stop reason (pointer still advances in place) but replaces a
      -- temporary call_in_progress / norma_call pause.
      v_action := public.voicemail_drop_settle_enrollment(
        e.id, v_step_index, true,
        case when p_pause_reason = 'step_misconfigured' and e.status = 'paused'
               and e.pause_reason not in ('reconciliation_required', 'call_in_progress', 'norma_call')
             then null else p_pause_reason end);
    elsif v_result <> 'conflict' then
      v_action := public.voicemail_drop_settle_enrollment(e.id, coalesce(v_step_index, -1), false, p_pause_reason);
    end if;
  end if;

  return query select v_result, v_action;
end;
$$;
revoke all on function public.resolve_voicemail_drop_outcome(uuid, text, text, text, text, text, numeric, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.resolve_voicemail_drop_outcome(uuid, text, text, text, text, text, numeric, text, jsonb)
  to service_role;

-- A seller calling back must also override a temporary call pause
-- (call_in_progress / norma_call), the way fn_norma_upgrade_pauses_for_reply
-- does for a reply; otherwise the softphone / Norma release (which only
-- resumes its own reason) would restart the drip. Returns rows upgraded.
create or replace function public.upgrade_temporary_pauses_for_inbound_call(p_property_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer := 0;
begin
  begin
    update public.sequence_enrollments e
       set pause_reason = 'inbound_call', updated_at = now()
     where e.property_id = any(p_property_ids) and e.status = 'paused'
       and e.pause_reason in ('call_in_progress', 'norma_call');
    get diagnostics v_n = row_count;
  exception when others then
    -- Same as fn_norma_upgrade_pauses_for_reply: a DNC lock makes the lead
    -- permanently opted out anyway, so there is nothing to upgrade.
    if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
    return 0;
  end;
  return v_n;
end;
$$;
revoke all on function public.upgrade_temporary_pauses_for_inbound_call(uuid[]) from public, anon, authenticated;
grant execute on function public.upgrade_temporary_pauses_for_inbound_call(uuid[]) to service_role;

commit;
