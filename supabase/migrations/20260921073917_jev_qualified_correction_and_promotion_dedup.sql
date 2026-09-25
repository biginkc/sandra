-- Root review of 99b53455 (three Astra production blockers):
--
-- 1. fn_correct_jev_lead_decision / fn_apply_and_record_jev_lead_decision_
--    correction reject every pending-decision correction once the
--    property has been qualified to new_lead (e.g. by an EARLIER,
--    unrelated decision) — the pending branch required status =
--    'prospect' exactly, but promotion of a NEW unclear/failed
--    classification on an already-qualified property is legitimate: it
--    only asserts decision_context_revision equality (already checked
--    above, unaffected) plus outreach_dispo still being unset. Widened
--    the accepted statuses to ('prospect', 'new_lead') for the pending
--    branch; outreach_dispo is still required to be null, and the exact
--    revision check already rejects any real staleness.
--
-- 2. fn_apply_and_record_ai_disposition_review_correction / fn_correct_
--    ai_disposition_review compare property.outreach_dispo against the
--    review's expected disposition — but a 'new_lead' correction/outcome
--    is recorded via property.status, never outreach_dispo (which stays
--    null). Once a review's corrected_disposition was 'new_lead', every
--    subsequent correction call compared outreach_dispo (null) to
--    'new_lead' and always raised STALE_STATE. Both functions now check
--    property.status = 'new_lead' for that one case, falling back to the
--    existing outreach_dispo comparison otherwise. fn_correct_ai_
--    disposition_review's property select is widened to include status
--    (it previously only read outreach_dispo) — needed to run this check.
--
-- 3. jev_needs_decision_classifier_events excluded a run only when a
--    decision existed with classification_run_id = cr.id — an exact-run
--    match. Promotion is idempotent per source_inbound_message_id (a
--    unique constraint on jev_lead_decisions), so once run B on an
--    inbound is promoted, an EARLIER failed run A on the SAME inbound
--    (different id, never itself promoted) still passed that check and
--    reappeared in the queue forever. Fixed by excluding on
--    source_inbound_message_id instead of classification_run_id — any
--    already-promoted decision for the same inbound now excludes every
--    run on that inbound, matching the real idempotency key. DISTINCT ON
--    dedup, security_invoker, and ordering are unchanged from
--    20260921072107.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ----------------------------------------------------------------------------
-- Blocker 1a
-- ----------------------------------------------------------------------------
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
    -- Blocker 1: a promoted decision's property may already be
    -- qualified (new_lead) via an earlier, unrelated decision — the
    -- exact decision_context_revision check above already rejects any
    -- real staleness, so this defense-in-depth check only needs to
    -- reject an outreach_dispo already having been set.
    if v_property.status not in ('prospect', 'new_lead') or v_property.outreach_dispo is not null then
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

-- ----------------------------------------------------------------------------
-- Blocker 1b
-- ----------------------------------------------------------------------------
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

  select * into v_decision from public.jev_lead_decisions where id = p_decision_id;
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

  select * into v_decision from public.jev_lead_decisions where id = p_decision_id for update;

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
    -- Blocker 1 (same fix as fn_correct_jev_lead_decision above).
    if v_property.status not in ('prospect', 'new_lead') or v_property.outreach_dispo is not null then
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

-- ----------------------------------------------------------------------------
-- Blocker 2a
-- ----------------------------------------------------------------------------
create or replace function public.fn_apply_and_record_ai_disposition_review_correction(
  p_review_id uuid,
  p_corrected_disposition text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_review public.ai_disposition_reviews%rowtype;
  v_property record;
  v_updated_id uuid;
  v_new_revision bigint;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_disposition not in ('new_lead', 'opted_out', 'dnc') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_review from public.ai_disposition_reviews where id = p_review_id;
  if not found then
    raise exception 'REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.is_training, p.homeowner_contact_id, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_review.property_id and p.org_id = v_review.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_property.is_training then
    raise exception 'Customer actions are unavailable for an internal training lead.' using errcode = '22023';
  end if;

  select * into v_review from public.ai_disposition_reviews where id = p_review_id for update;

  if v_property.decision_context_revision is distinct from v_review.decision_context_revision then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_review.status <> 'pending' and v_review.corrected_disposition = p_corrected_disposition then
    return jsonb_build_object(
      'status', 'already_corrected', 'reviewId', v_review.id,
      'correctedDisposition', p_corrected_disposition
    );
  end if;

  if v_review.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Defense in depth: the specific column values this review actually
  -- expects, checked in addition to the revision gate above.
  --
  -- Blocker 2: a 'new_lead' expected disposition is recorded via
  -- property.status, never outreach_dispo (promotion to new_lead leaves
  -- outreach_dispo null) — checked against status, not outreach_dispo.
  if v_review.status = 'pending' and v_review.dispo_applied then
    if v_property.outreach_dispo is distinct from v_review.disposition then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_review.status = 'pending' and not v_review.dispo_applied then
    if v_property.outreach_dispo is not null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif coalesce(v_review.corrected_disposition, v_review.disposition) = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_property.outreach_dispo is distinct from coalesce(v_review.corrected_disposition, v_review.disposition) then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- ------------------------------------------------------------------
  -- Atomic write: the WHERE clause below is the last-instant concurrency
  -- control for anything happening DURING this very function call (the
  -- revision check above already ruled out anything before it started).
  -- ------------------------------------------------------------------
  if p_corrected_disposition = 'new_lead' then
    if v_property.is_dnc_locked then
      raise exception 'DNC_LOCKED: property is permanently read-only' using errcode = '22023';
    end if;
    update public.properties
    set status = 'new_lead', qualified_at = now(), qualified_by = v_actor, updated_at = now()
    where id = v_review.property_id and org_id = v_review.org_id
      and status = 'prospect' and is_dnc_locked = false
    returning id, decision_context_revision into v_updated_id, v_new_revision;
    if v_updated_id is null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    update public.properties
    set outreach_dispo = p_corrected_disposition, follow_up_at = null, updated_at = now()
    where id = v_review.property_id and org_id = v_review.org_id
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
  end if;

  update public.ai_disposition_reviews
  set corrected_disposition = p_corrected_disposition,
      corrected_at = now(),
      corrected_by = v_actor,
      correction_reason = nullif(btrim(p_reason), ''),
      dispo_applied = true,
      status = case when status = 'pending' then 'confirmed' else status end,
      resolved_at = case when status = 'pending' then now() else resolved_at end,
      reviewed_by = case when status = 'pending' then v_actor else reviewed_by end,
      human_reviewed_at = coalesce(human_reviewed_at, now()),
      human_reviewed_by = coalesce(human_reviewed_by, v_actor),
      decision_context_revision = v_new_revision
  where id = p_review_id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload
  ) values (
    v_review.org_id, v_review.property_id, 'user', v_actor,
    'ai_disposition_review_corrected',
    jsonb_build_object(
      'review_id', v_review.id,
      'original_disposition', v_review.disposition,
      'previous_corrected_disposition', v_review.corrected_disposition,
      'corrected_disposition', p_corrected_disposition,
      'reason', p_reason,
      'applied_via', case p_corrected_disposition
        when 'new_lead' then 'qualifyProperty' else 'setOutreachDispo'
      end
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'reviewId', v_review.id,
    'correctedDisposition', p_corrected_disposition,
    'propertyId', v_review.property_id,
    'homeownerContactId', v_property.homeowner_contact_id
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Blocker 2b
-- ----------------------------------------------------------------------------
create or replace function public.fn_correct_ai_disposition_review(
  p_review_id uuid,
  p_corrected_disposition text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_review public.ai_disposition_reviews%rowtype;
  v_property record;
  v_expected_dispo text;
  v_new_revision bigint;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_disposition not in ('wrong_number', 'not_interested', 'nurture') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_review
  from public.ai_disposition_reviews
  where id = p_review_id;
  if not found then
    raise exception 'REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  -- Blocker 2: status is now selected too — needed below to detect a
  -- 'new_lead' expected disposition, which lives on property.status, not
  -- outreach_dispo.
  select p.status, p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_review.property_id and p.org_id = v_review.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_review
  from public.ai_disposition_reviews
  where id = p_review_id
  for update;

  if v_property.decision_context_revision is distinct from v_review.decision_context_revision then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_review.status <> 'pending' and v_review.corrected_disposition = p_corrected_disposition then
    return jsonb_build_object(
      'status', 'already_corrected', 'reviewId', v_review.id,
      'correctedDisposition', p_corrected_disposition
    );
  end if;

  if v_review.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  v_expected_dispo := case
    when v_review.corrected_disposition is not null then v_review.corrected_disposition
    when v_review.dispo_applied then v_review.disposition
    else null
  end;

  if v_expected_dispo = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_expected_dispo is not null then
    if v_property.outreach_dispo is distinct from v_expected_dispo then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is not null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  if v_property.outreach_dispo is distinct from p_corrected_disposition
     and v_property.outreach_dispo in ('opted_out', 'dnc', 'bad_number', 'callback_requested', 'booked_appointment')
  then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  update public.ai_disposition_reviews
  set corrected_disposition = p_corrected_disposition,
      corrected_at = now(),
      corrected_by = v_actor,
      correction_reason = nullif(btrim(p_reason), ''),
      dispo_applied = true,
      status = case when status = 'pending' then 'confirmed' else status end,
      resolved_at = case when status = 'pending' then now() else resolved_at end,
      reviewed_by = case when status = 'pending' then v_actor else reviewed_by end
  where id = v_review.id;

  if v_property.outreach_dispo is distinct from p_corrected_disposition then
    update public.properties
    set outreach_dispo = p_corrected_disposition,
        needs_human_attention = false,
        last_ai_escalation_reason = null,
        updated_at = now()
    where id = v_review.property_id and org_id = v_review.org_id
    returning decision_context_revision into v_new_revision;
  else
    v_new_revision := v_property.decision_context_revision;
  end if;

  update public.ai_disposition_reviews
  set decision_context_revision = v_new_revision
  where id = v_review.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload
  ) values (
    v_review.org_id, v_review.property_id, 'user', v_actor,
    'ai_disposition_review_corrected',
    jsonb_build_object(
      'review_id', v_review.id,
      'original_disposition', v_review.disposition,
      'previous_corrected_disposition', v_review.corrected_disposition,
      'corrected_disposition', p_corrected_disposition,
      'reason', p_reason
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'reviewId', v_review.id,
    'correctedDisposition', p_corrected_disposition
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Blocker 3
-- ----------------------------------------------------------------------------
create or replace view public.jev_needs_decision_classifier_events
with (security_invoker = true) as
select distinct on (cr.source_inbound_message_id)
  cr.id,
  cr.org_id,
  cr.property_id,
  cr.conversation_id,
  cr.source_inbound_message_id,
  cr.resolved_outcome,
  cr.fallback_reason,
  cr.model,
  cr.schema_version,
  cr.policy_version,
  cr.decision,
  cr.created_at
from public.sms_classification_runs cr
where cr.provider = 'jev'
  and (cr.fallback_reason is not null or cr.resolved_outcome in ('unclear', 'bad_number'))
  -- Blocker 3: promotion is idempotent by source_inbound_message_id
  -- (jev_lead_decisions has a unique constraint on it), not by
  -- classification_run_id — exclude the whole inbound once ANY decision
  -- exists for it, so an earlier failed run on the same inbound as a
  -- later promoted one can never reappear.
  and not exists (
    select 1
    from public.jev_lead_decisions d
    where d.source_inbound_message_id = cr.source_inbound_message_id
  )
  -- Not a stale failure superseded by a later successful (non-fallback)
  -- retry on the SAME inbound (round 11/12 reconciliation) — a
  -- successful run's own fallback_reason is always null, so failures
  -- never exclude themselves here.
  and (
    cr.fallback_reason is null
    or not exists (
      select 1
      from public.sms_classification_runs succ
      where succ.provider = 'jev'
        and succ.fallback_reason is null
        and succ.source_inbound_message_id = cr.source_inbound_message_id
    )
  )
order by cr.source_inbound_message_id, cr.created_at desc, cr.id desc;

grant select on public.jev_needs_decision_classifier_events to authenticated;

commit;
