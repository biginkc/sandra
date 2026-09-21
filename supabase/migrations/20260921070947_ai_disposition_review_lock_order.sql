-- Fable re-review of e5d001bb (fable-final-review-e5d001bb.json,
-- jev-root-round17-fable2-fixes.md), finding 3 — P3 review-side deadlock
-- risk:
--
-- fn_correct_ai_disposition_review and
-- fn_apply_and_record_ai_disposition_review_correction locked review
-- THEN property; fn_confirm_ai_disposition_review and the three
-- service-role paths in 20260921025446 lock property THEN review — the
-- exact same class of bug 20260921064657 fixed for jev_lead_decisions,
-- left unfixed on the ai_disposition_reviews side.
--
-- Fixed the same way: reorder to property BEFORE review. The initial
-- review read becomes unlocked (used only to find property_id/org_id
-- and run the authorization check); every field actually acted on comes
-- from a SECOND, locked read taken after the property lock — logic is
-- otherwise byte-for-byte unchanged.

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

  -- Root review of f271492e (jev-root-cas-review.md, 2026-09-20): the
  -- authoritative staleness gate. A mismatch means something decision-
  -- relevant happened since this review's own last recorded state —
  -- ANY write to outreach_dispo/status/homeowner_contact_id/qualified_at
  -- (even a same-value one), a new inbound, or a new appointment. This
  -- catches everything the narrower column checks below cannot: a
  -- disposition-only race hiding a status change, a status-only race
  -- hiding a dispo change, ABA, and cross-table activity.
  if v_property.decision_context_revision is distinct from v_review.decision_context_revision then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Explicit replay identity ("Replay identity should be explicit, not
  -- mistaken for unrelated human state matching desired value"): this
  -- row's own last correction already achieved exactly this outcome,
  -- and — per the revision check just above — nothing decision-relevant
  -- has happened since. Not a value-equality coincidence with someone
  -- else's unrelated action.
  if v_review.status <> 'pending' and v_review.corrected_disposition = p_corrected_disposition then
    return jsonb_build_object(
      'status', 'already_corrected', 'reviewId', v_review.id,
      'correctedDisposition', p_corrected_disposition
    );
  end if;

  -- trg_properties_supersede_ai_disposition_reviews (an outreach_dispo
  -- write) and fn_propose_deferred_ai_disposition_review's manual
  -- supersede (a NEW proposal superseding an old pending one, which does
  -- NOT itself write outreach_dispo) can both mark this review
  -- 'superseded' without necessarily bumping decision_context_revision —
  -- kept as its own explicit check, not subsumed by the revision gate.
  if v_review.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Defense in depth: the specific column values this review actually
  -- expects, checked in addition to the revision gate above.
  if v_review.status = 'pending' and v_review.dispo_applied then
    if v_property.outreach_dispo is distinct from v_review.disposition then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_review.status = 'pending' and not v_review.dispo_applied then
    if v_property.outreach_dispo is not null then
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
        -- A 'dnc' write can cascade-lock the linked contact before this
        -- statement runs (reject_locked_property_contact_mutation) —
        -- the contact is ALREADY suppressed by that lock, same tolerance
        -- setOutreachDispo itself already applies for this exact case.
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

  select p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention, p.decision_context_revision
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

  if v_expected_dispo is not null then
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
