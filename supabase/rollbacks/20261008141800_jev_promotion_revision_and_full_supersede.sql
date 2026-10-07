-- Rollback for 20261008141800_jev_promotion_revision_and_full_supersede.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration replaced: restore the prior body (and grants).
-- fn_promote_classifier_event_to_decision(uuid): restore body from 20261008141700_jev_lock_order_and_promotion_safety.sql
create or replace function public.fn_promote_classifier_event_to_decision(
  p_classification_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_run public.sms_classification_runs%rowtype;
  v_property record;
  v_pending public.jev_lead_decisions%rowtype;
  v_existing public.jev_lead_decisions%rowtype;
  v_decision public.jev_lead_decisions%rowtype;
  v_placeholder_outcome text;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  select * into v_run
  from public.sms_classification_runs
  where id = p_classification_run_id
  for share;
  if not found then
    raise exception 'CLASSIFICATION_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_run.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_run.provider <> 'jev' then
    raise exception 'NOT_A_CLASSIFIER_EVENT' using errcode = '22023';
  end if;
  if v_run.fallback_reason is null
    and (v_run.resolved_outcome is null or v_run.resolved_outcome not in ('unclear', 'bad_number'))
  then
    raise exception 'NOT_A_CLASSIFIER_EVENT' using errcode = '22023';
  end if;

  v_placeholder_outcome := coalesce(v_run.resolved_outcome, 'unclear');

  -- Lock the property BEFORE touching jev_lead_decisions — same order
  -- confirm/correct/apply use, so a promotion can never deadlock against
  -- them.
  select p.id into v_property
  from public.properties p
  where p.id = v_run.property_id and p.org_id = v_run.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Race-safe via jev_lead_decisions' existing unique constraint on
  -- source_inbound_message_id: a concurrent double-promotion of the same
  -- inbound conflicts and this branch re-reads the winner instead.
  select * into v_existing
  from public.jev_lead_decisions
  where source_inbound_message_id = v_run.source_inbound_message_id;
  if v_existing.id is not null then
    return jsonb_build_object('status', 'already_promoted', 'decisionId', v_existing.id);
  end if;

  -- One pending decision per property: a DIFFERENT classifier event
  -- (different source_inbound_message_id) already promoted for this
  -- SAME property and still pending must be superseded first, not left
  -- to coexist alongside the new one.
  select * into v_pending
  from public.jev_lead_decisions
  where org_id = v_run.org_id
    and property_id = v_run.property_id
    and status = 'pending'
  for update;
  if v_pending.id is not null then
    update public.jev_lead_decisions
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'new_classifier_event_promoted'
    where id = v_pending.id;
  end if;

  insert into public.jev_lead_decisions (
    org_id, property_id, conversation_id, source_inbound_message_id,
    classification_run_id, proposed_outcome, status
  ) values (
    v_run.org_id, v_run.property_id, v_run.conversation_id, v_run.source_inbound_message_id,
    p_classification_run_id, v_placeholder_outcome, 'pending'
  )
  on conflict (source_inbound_message_id) do nothing
  returning * into v_decision;

  if v_decision.id is null then
    select * into v_existing
    from public.jev_lead_decisions
    where source_inbound_message_id = v_run.source_inbound_message_id;
    return jsonb_build_object('status', 'already_promoted', 'decisionId', v_existing.id);
  end if;

  update public.properties
  set needs_human_attention = true, updated_at = now()
  where id = v_run.property_id and org_id = v_run.org_id;

  insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload)
  values (
    v_run.org_id, v_run.property_id, 'user', v_actor, 'jev_classifier_event_promoted',
    jsonb_build_object(
      'classification_run_id', p_classification_run_id,
      'decision_id', v_decision.id,
      'placeholder_outcome', v_placeholder_outcome,
      'fallback_reason', v_run.fallback_reason,
      'superseded_pending_decision_id', v_pending.id
    )
  );

  return jsonb_build_object('status', 'promoted', 'decisionId', v_decision.id);
end;
$$;
revoke all on function public.fn_promote_classifier_event_to_decision(uuid)
  from public, anon, service_role;
grant execute on function public.fn_promote_classifier_event_to_decision(uuid) to authenticated;

commit;
