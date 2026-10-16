-- Rollback for 20261008141700_jev_lock_order_and_promotion_safety.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration replaced: restore the prior body (and grants).
-- fn_confirm_jev_lead_decision(uuid): restore body from 20261008140800_jev_decision_context_revision.sql
create or replace function public.fn_confirm_jev_lead_decision(p_decision_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision public.jev_lead_decisions%rowtype;
  v_property record;
  v_new_revision bigint;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  select * into v_decision
  from public.jev_lead_decisions
  where id = p_decision_id;
  if not found then
    raise exception 'DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_decision.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_decision
  from public.jev_lead_decisions
  where id = p_decision_id
  for update;

  if v_decision.status <> 'pending' then
    return jsonb_build_object(
      'status', v_decision.status, 'decisionId', v_decision.id,
      'resolvedOutcome', v_decision.resolved_outcome
    );
  end if;

  if v_property.decision_context_revision is distinct from v_decision.decision_context_revision then
    update public.jev_lead_decisions
    set status = 'superseded', resolved_at = now(),
        superseded_reason = 'property_outcome_changed'
    where id = v_decision.id;
    return jsonb_build_object('status', 'superseded', 'decisionId', v_decision.id);
  end if;

  if v_decision.proposed_outcome = 'new_lead' then
    if v_property.is_dnc_locked then
      raise exception 'DNC_LOCKED' using errcode = '22023';
    end if;
    if v_property.status is distinct from 'prospect' then
      update public.jev_lead_decisions
      set status = 'superseded', resolved_at = now(),
          superseded_reason = 'property_outcome_changed'
      where id = v_decision.id;
      return jsonb_build_object('status', 'superseded', 'decisionId', v_decision.id);
    end if;
    update public.properties
    set status = 'new_lead',
        qualified_at = now(),
        qualified_by = v_actor::text,
        updated_at = now()
    where id = v_decision.property_id and org_id = v_decision.org_id
    returning decision_context_revision into v_new_revision;
  else
    -- nurture: must still be unset or already nurture (idempotent replay).
    if v_property.outreach_dispo is not null and v_property.outreach_dispo <> 'nurture' then
      update public.jev_lead_decisions
      set status = 'superseded', resolved_at = now(),
          superseded_reason = 'property_outcome_changed'
      where id = v_decision.id;
      return jsonb_build_object('status', 'superseded', 'decisionId', v_decision.id);
    end if;
    update public.properties
    set outreach_dispo = 'nurture',
        needs_human_attention = false,
        last_ai_escalation_reason = null,
        updated_at = now()
    where id = v_decision.property_id and org_id = v_decision.org_id
    returning decision_context_revision into v_new_revision;
  end if;

  update public.jev_lead_decisions
  set status = 'confirmed',
      resolved_outcome = v_decision.proposed_outcome,
      resolved_at = now(),
      resolved_by = v_actor,
      decision_context_revision = v_new_revision
  where id = v_decision.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    v_decision.org_id, v_decision.property_id, 'user', v_actor,
    'jev_lead_decision_confirmed',
    jsonb_build_object('decision_id', v_decision.id, 'outcome', v_decision.proposed_outcome),
    'jev_lead_decisions.confirmed', v_decision.id
  )
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return jsonb_build_object(
    'status', 'confirmed', 'decisionId', v_decision.id,
    'resolvedOutcome', v_decision.proposed_outcome
  );
end;
$$;
revoke all on function public.fn_confirm_jev_lead_decision(uuid)
  from public, anon, service_role;
grant execute on function public.fn_confirm_jev_lead_decision(uuid) to authenticated;
-- fn_correct_jev_lead_decision(uuid, text, text): restore body from 20261008140800_jev_decision_context_revision.sql
create or replace function public.fn_correct_jev_lead_decision(
  p_decision_id uuid,
  p_corrected_outcome text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision public.jev_lead_decisions%rowtype;
  v_property record;
  v_new_revision bigint;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_outcome not in ('new_lead', 'nurture', 'wrong_number', 'not_interested') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_decision
  from public.jev_lead_decisions
  where id = p_decision_id
  for update;
  if not found then
    raise exception 'DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_decision.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_property.decision_context_revision is distinct from v_decision.decision_context_revision then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_decision.status <> 'pending' and v_decision.resolved_outcome = p_corrected_outcome then
    return jsonb_build_object(
      'status', 'already_corrected', 'decisionId', v_decision.id,
      'resolvedOutcome', p_corrected_outcome
    );
  end if;

  if v_decision.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_decision.status = 'pending' then
    if v_property.status is distinct from 'prospect' or v_property.outreach_dispo is not null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_decision.resolved_outcome = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is distinct from v_decision.resolved_outcome then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  v_new_revision := v_property.decision_context_revision;

  if p_corrected_outcome = 'new_lead' then
    if v_property.is_dnc_locked then
      raise exception 'DNC_LOCKED' using errcode = '22023';
    end if;
    if v_property.status is distinct from 'prospect' and v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
    if v_property.status is distinct from 'new_lead' then
      update public.properties
      set status = 'new_lead', qualified_at = now(), qualified_by = v_actor::text,
          updated_at = now()
      where id = v_decision.property_id and org_id = v_decision.org_id
      returning decision_context_revision into v_new_revision;
    end if;
  else
    if v_property.outreach_dispo is distinct from p_corrected_outcome then
      if v_property.outreach_dispo in ('opted_out', 'dnc', 'bad_number', 'callback_requested', 'booked_appointment') then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
      update public.properties
      set outreach_dispo = p_corrected_outcome,
          needs_human_attention = false,
          last_ai_escalation_reason = null,
          updated_at = now()
      where id = v_decision.property_id and org_id = v_decision.org_id
      returning decision_context_revision into v_new_revision;
    end if;
  end if;

  update public.jev_lead_decisions
  set status = 'corrected',
      resolved_outcome = p_corrected_outcome,
      resolved_at = now(),
      resolved_by = v_actor,
      resolution_reason = nullif(btrim(p_reason), ''),
      decision_context_revision = v_new_revision
  where id = v_decision.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload
  ) values (
    v_decision.org_id, v_decision.property_id, 'user', v_actor,
    'jev_lead_decision_corrected',
    jsonb_build_object(
      'decision_id', v_decision.id,
      'proposed_outcome', v_decision.proposed_outcome,
      'previous_resolved_outcome', v_decision.resolved_outcome,
      'corrected_outcome', p_corrected_outcome,
      'reason', p_reason
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'decisionId', v_decision.id,
    'resolvedOutcome', p_corrected_outcome
  );
end;
$$;
revoke all on function public.fn_correct_jev_lead_decision(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_correct_jev_lead_decision(uuid, text, text) to authenticated;
-- fn_apply_and_record_jev_lead_decision_correction(uuid, text, text): restore body from 20261008140800_jev_decision_context_revision.sql
create or replace function public.fn_apply_and_record_jev_lead_decision_correction(
  p_decision_id uuid,
  p_corrected_outcome text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision public.jev_lead_decisions%rowtype;
  v_property record;
  v_updated_id uuid;
  v_new_revision bigint;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_outcome not in ('opted_out', 'dnc') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_decision from public.jev_lead_decisions where id = p_decision_id for update;
  if not found then
    raise exception 'DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_decision.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.is_training, p.homeowner_contact_id, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_property.is_training then
    raise exception 'Customer actions are unavailable for an internal training lead.' using errcode = '22023';
  end if;

  if v_property.decision_context_revision is distinct from v_decision.decision_context_revision then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_decision.status <> 'pending' and v_decision.resolved_outcome = p_corrected_outcome then
    return jsonb_build_object(
      'status', 'already_corrected', 'decisionId', v_decision.id,
      'resolvedOutcome', p_corrected_outcome
    );
  end if;

  if v_decision.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_decision.status = 'pending' then
    if v_property.status is distinct from 'prospect' or v_property.outreach_dispo is not null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_decision.resolved_outcome = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is distinct from v_decision.resolved_outcome then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  update public.properties
  set outreach_dispo = p_corrected_outcome, follow_up_at = null, updated_at = now()
  where id = v_decision.property_id and org_id = v_decision.org_id
    and outreach_dispo is not distinct from v_property.outreach_dispo
  returning id, decision_context_revision into v_updated_id, v_new_revision;
  if v_updated_id is null then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_property.homeowner_contact_id is not null then
    begin
      update public.contacts
      set sms_opted_out = true, sms_opted_out_at = now()
      where id = v_property.homeowner_contact_id
        and do_not_contact = false and sms_opted_out = false;
    exception when others then
      if sqlerrm not like 'DNC_LOCKED%' then
        raise;
      end if;
    end;
  end if;

  update public.jev_lead_decisions
  set status = 'corrected',
      resolved_outcome = p_corrected_outcome,
      resolved_at = now(),
      resolved_by = v_actor,
      resolution_reason = nullif(btrim(p_reason), ''),
      human_reviewed_at = coalesce(human_reviewed_at, now()),
      human_reviewed_by = coalesce(human_reviewed_by, v_actor),
      decision_context_revision = v_new_revision
  where id = p_decision_id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload
  ) values (
    v_decision.org_id, v_decision.property_id, 'user', v_actor,
    'jev_lead_decision_corrected',
    jsonb_build_object(
      'decision_id', v_decision.id,
      'proposed_outcome', v_decision.proposed_outcome,
      'previous_resolved_outcome', v_decision.resolved_outcome,
      'corrected_outcome', p_corrected_outcome,
      'reason', p_reason,
      'applied_via', 'setOutreachDispo'
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'decisionId', v_decision.id,
    'resolvedOutcome', p_corrected_outcome,
    'propertyId', v_decision.property_id,
    'homeownerContactId', v_property.homeowner_contact_id
  );
end;
$$;
revoke all on function public.fn_apply_and_record_jev_lead_decision_correction(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_apply_and_record_jev_lead_decision_correction(uuid, text, text) to authenticated;
revoke all on function public.fn_apply_and_record_jev_lead_decision_correction(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_apply_and_record_jev_lead_decision_correction(uuid, text, text) to authenticated;
-- fn_promote_classifier_event_to_decision(uuid): restore body from 20261008140500_jev_classifier_event_resolution.sql
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
    -- This run produced an actual actionable decision (route/nurture/
    -- new_lead) — it already has its own review/decision row and does
    -- not belong in this promotion path.
    raise exception 'NOT_A_CLASSIFIER_EVENT' using errcode = '22023';
  end if;

  v_placeholder_outcome := coalesce(v_run.resolved_outcome, 'unclear');

  -- Race-safe via jev_lead_decisions' existing unique constraint on
  -- source_inbound_message_id: a concurrent double-promotion of the same
  -- inbound conflicts and this branch re-reads the winner instead.
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
      'fallback_reason', v_run.fallback_reason
    )
  );

  return jsonb_build_object('status', 'promoted', 'decisionId', v_decision.id);
end;
$$;
revoke all on function public.fn_promote_classifier_event_to_decision(uuid)
  from public, anon, service_role;
grant execute on function public.fn_promote_classifier_event_to_decision(uuid) to authenticated;

commit;
