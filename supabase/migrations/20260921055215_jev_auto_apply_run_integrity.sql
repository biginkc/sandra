-- Root review of 999feefb (jev-root-round11-review.md), finding 3:
--
-- fn_auto_apply_jev_lead_decision is service-role-only, called from a
-- single trusted call site in dispatch.ts — but it took p_classification_run_id
-- on faith, inserting it straight into jev_lead_decisions.classification_run_id
-- with no verification it actually belongs to THIS org/property/conversation/
-- source inbound message, was produced by the 'jev' provider, or that its
-- own resolved_outcome even matches p_outcome. A caller bug (a stale run id
-- left over from a retry, a copy/paste across two dispatch calls, a legacy
-- run id) could fabricate or mislink jev_lead_decisions' audit history
-- while still applying a real effect to the property.
--
-- Fixed: before the property is even locked, verify the run row exists
-- and its org_id/property_id/conversation_id/source_inbound_message_id/
-- provider/resolved_outcome all match this call's own parameters. A
-- mismatch fails closed (no effect, no audit row) with a distinct error.

create or replace function public.fn_auto_apply_jev_lead_decision(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_classification_run_id uuid,
  p_outcome text,
  p_native_confidence numeric,
  p_threshold_at_decision numeric,
  p_threshold_version integer,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message record;
  v_org_id uuid;
  v_run record;
  v_existing public.jev_lead_decisions%rowtype;
  v_pending public.jev_lead_decisions%rowtype;
  v_row public.jev_lead_decisions%rowtype;
  v_property record;
  v_effect_status text;
  v_updated_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome not in ('new_lead', 'nurture') then
    raise exception 'unsupported outcome for jev_lead_decisions: %', p_outcome
      using errcode = '22023';
  end if;

  select m.id, m.org_id, m.property_id, m.conversation_id
  into v_message
  from public.messages m
  where m.id = p_source_inbound_message_id
    and m.channel = 'sms'
    and m.direction = 'inbound'
  for share;

  if not found
    or v_message.property_id is distinct from p_property_id
    or v_message.conversation_id is distinct from p_conversation_id
  then
    raise exception 'inbound SMS does not match property/conversation'
      using errcode = '23514';
  end if;
  v_org_id := v_message.org_id;

  -- Root review of 999feefb, finding 3: the audit trail's own integrity
  -- guard — verify the classification run this decision cites is REALLY
  -- the one that produced it, before any effect or insert happens.
  select cr.org_id, cr.property_id, cr.conversation_id, cr.source_inbound_message_id,
         cr.provider, cr.resolved_outcome
  into v_run
  from public.sms_classification_runs cr
  where cr.id = p_classification_run_id;
  if not found
    or v_run.org_id is distinct from v_org_id
    or v_run.property_id is distinct from p_property_id
    or v_run.conversation_id is distinct from p_conversation_id
    or v_run.source_inbound_message_id is distinct from p_source_inbound_message_id
    or v_run.provider is distinct from 'jev'
    or v_run.resolved_outcome is distinct from p_outcome
  then
    raise exception 'classification_run_id does not match this decision (org/property/conversation/source message/provider/outcome)'
      using errcode = '23514';
  end if;

  select * into v_existing
  from public.jev_lead_decisions d
  where d.source_inbound_message_id = p_source_inbound_message_id;
  if found then
    return jsonb_build_object('status', 'replayed', 'decisionId', v_existing.id);
  end if;

  -- Lock the property row and read everything the effect below needs, in
  -- ONE select — the SAME row version the revision check below judges.
  select
    p.decision_context_revision, p.outreach_dispo, p.status,
    p.is_dnc_locked, p.is_training
  into v_property
  from public.properties p
  where p.id = p_property_id and p.org_id = v_org_id
  for update;
  if not found then
    raise exception 'property does not match inbound SMS organization' using errcode = '23514';
  end if;
  if v_property.decision_context_revision is distinct from p_expected_revision then
    -- Fail closed, distinctly from a generic write failure: the model's
    -- OWN input context is no longer current, so auto-applying it would
    -- silently apply a decision made against stale data. Checked BEFORE
    -- any write this function makes — never rebased or bumped by this
    -- call itself.
    raise exception 'STALE_DECISION_CONTEXT' using errcode = '40001';
  end if;

  -- ------------------------------------------------------------------
  -- Effect: applied atomically with the revision check above (same
  -- transaction, same locked row) and BEFORE the audit insert below, so
  -- a decision row only ever exists for an outcome that was actually
  -- (or was already) applied.
  -- ------------------------------------------------------------------
  if p_outcome = 'nurture' then
    if v_property.is_training then
      raise exception 'Customer actions are unavailable for an internal training lead.' using errcode = '22023';
    end if;
    if v_property.outreach_dispo is not null and v_property.outreach_dispo <> 'nurture' then
      -- Something more specific already set (possibly by a human while
      -- Jev was classifying) — nurture must never downgrade it. Same
      -- "already_terminal" treatment setOutreachDispoNurture already
      -- had; no decision row recorded for this case (matches the TS
      -- caller's existing silent-skip branch).
      return jsonb_build_object('status', 'already_terminal');
    end if;
    if v_property.outreach_dispo is distinct from 'nurture' then
      update public.properties
      set outreach_dispo = 'nurture', follow_up_at = null, updated_at = now()
      where id = p_property_id and org_id = v_org_id
        and outreach_dispo is not distinct from v_property.outreach_dispo
      returning id into v_updated_id;
      if v_updated_id is null then
        -- Defense in depth: the row is already locked FOR UPDATE above,
        -- so this branch should be unreachable, but never silently
        -- apply on an unexpected miss.
        return jsonb_build_object('status', 'already_terminal');
      end if;
      v_effect_status := 'applied';
    else
      -- Already exactly 'nurture' — idempotent no-op, but (matching the
      -- prior TS behavior) still proceeds to record the decision.
      v_effect_status := 'already_nurture';
    end if;
  else -- new_lead
    if v_property.is_dnc_locked then
      return jsonb_build_object('status', 'dnc_locked');
    end if;
    if v_property.status is distinct from 'prospect' then
      -- Already promoted via another path — matches qualifyProperty's
      -- "already_qualified": still records the decision (Jev's call was
      -- correct, even though something else got there first).
      v_effect_status := 'already_qualified';
    else
      update public.properties
      set status = 'new_lead', qualified_at = now(), qualified_by = 'system:jev_auto_promote', updated_at = now()
      where id = p_property_id and org_id = v_org_id
        and status = 'prospect' and is_dnc_locked = false
      returning id into v_updated_id;
      if v_updated_id is null then
        -- Defense in depth: row already locked FOR UPDATE above, so this
        -- should be unreachable.
        return jsonb_build_object('status', 'not_found');
      end if;
      v_effect_status := 'applied';
    end if;
  end if;

  select d.* into v_pending
  from public.jev_lead_decisions d
  where d.org_id = v_org_id
    and d.property_id = p_property_id
    and d.status = 'pending'
  for update;

  if v_pending.id is not null then
    update public.jev_lead_decisions
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'new_ai_decision'
    where id = v_pending.id;
  end if;

  insert into public.jev_lead_decisions (
    org_id, property_id, conversation_id, source_inbound_message_id,
    classification_run_id, proposed_outcome, native_confidence,
    threshold_at_decision, threshold_version, status, resolved_outcome, resolved_at
  ) values (
    v_org_id, p_property_id, p_conversation_id, p_source_inbound_message_id,
    p_classification_run_id, p_outcome, p_native_confidence,
    p_threshold_at_decision, p_threshold_version, 'confirmed', p_outcome, now()
  )
  returning * into v_row;

  return jsonb_build_object('status', v_effect_status, 'decisionId', v_row.id);
end;
$$;

revoke all on function public.fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer, bigint) to service_role;
