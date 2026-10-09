-- Root review of 02b0ad73 (jev-root-correction-race.md, 2026-09-20):
-- the begin -> TS sanctioned op -> record sequence is NOT atomic. A
-- PostgREST RPC commits and releases its FOR UPDATE lock the instant it
-- returns; `qualifyProperty`/`setOutreachDispo` run in a SEPARATE
-- request/transaction, and their own CAS guards re-read "current" state
-- FRESH at that later moment rather than checking against what
-- `fn_begin_*` observed. A concurrent human write landing in that window
-- is silently overwritten — record's after-the-fact re-check cannot undo
-- a write that already happened. `fn_begin_*` never closed the TOCTOU
-- gap; it only narrowed the visible symptom.
--
-- Fix: fold "validate -> write -> audit" into ONE function, ONE
-- transaction, for exactly the three targets that previously needed a
-- separate sanctioned TS call (new_lead on ai_disposition_review;
-- opted_out/dnc on either source). The property UPDATE's WHERE clause is
-- now the actual optimistic-concurrency enforcement — checked by
-- Postgres against the live row at write time, not by an app-level
-- reread-then-compare — so a concurrent write between "we looked" and
-- "we wrote" is now IMPOSSIBLE to miss: the UPDATE simply matches zero
-- rows and this function raises STALE_STATE instead of silently
-- overwriting. wrong_number/not_interested/nurture (already-atomic
-- direct-SQL corrections via fn_correct_ai_disposition_review /
-- fn_correct_jev_lead_decision) and new_lead-on-jev_lead_decision (via
-- fn_correct_jev_lead_decision) are untouched — they never had this bug.
--
-- The now-superseded fn_begin_*/fn_record_* split is dropped outright
-- rather than left in place unused: leaving it would misrepresent it as
-- a safe path, which is exactly what root's finding says it never was.
--
-- Same suppression semantics as `setOutreachDispo`/`qualifyProperty`
-- (properties.is_dnc_locked trigger guard still applies unconditionally;
-- contacts.sms_opted_out is flipped, never cleared, for opted_out/dnc;
-- is_training is still blocked). Secondary, already best-effort concerns
-- in those TS functions (consent_events history row, sequence-pause,
-- revalidatePath) stay as TS follow-ups AFTER this RPC commits — exactly
-- the same "effect committed, secondary bookkeeping best-effort"
-- ordering `setOutreachDispo` itself already uses for those same steps.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

drop function if exists public.fn_begin_ai_disposition_review_correction(uuid, text);
drop function if exists public.fn_record_ai_disposition_review_correction(uuid, text, text);
drop function if exists public.fn_begin_jev_lead_decision_correction(uuid, text);
drop function if exists public.fn_record_jev_lead_decision_correction(uuid, text, text);

-- ----------------------------------------------------------------------------
-- fn_apply_and_record_ai_disposition_review_correction — atomic
-- validate+write+audit for new_lead/opted_out/dnc corrections on
-- ai_disposition_reviews.
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
  v_expected_dispo text;
  v_updated_id uuid;
  v_already_repeat boolean := false;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_disposition not in ('new_lead', 'opted_out', 'dnc') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_review from public.ai_disposition_reviews where id = p_review_id for update;
  if not found then
    raise exception 'REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.is_training, p.homeowner_contact_id
  into v_property
  from public.properties p
  where p.id = v_review.property_id and p.org_id = v_review.org_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_property.is_training then
    raise exception 'Customer actions are unavailable for an internal training lead.' using errcode = '22023';
  end if;

  -- Exact-repeat detection ("Repeated same-outcome human edits must
  -- still be detectable", jev-root-correction-race.md): this review was
  -- ALREADY corrected to exactly this outcome and the property still
  -- reflects it — a resend (double-click, retried request after a
  -- timeout) of an already-completed correction. Report it distinctly
  -- (status = 'already_corrected') and record NOTHING further — no
  -- duplicate lead_events row, no redundant write.
  if v_review.corrected_disposition = p_corrected_disposition then
    if p_corrected_disposition = 'new_lead' then
      v_already_repeat := v_property.status = 'new_lead';
    else
      v_already_repeat := v_property.outreach_dispo = p_corrected_disposition;
    end if;
  end if;
  if v_already_repeat then
    return jsonb_build_object(
      'status', 'already_corrected', 'reviewId', v_review.id,
      'correctedDisposition', p_corrected_disposition
    );
  end if;

  -- trg_properties_supersede_ai_disposition_reviews auto-supersedes any
  -- pending review the instant properties.outreach_dispo changes. A
  -- genuinely different superseding decision (a new Jev classification,
  -- or someone else's write to a different value) is real staleness.
  if v_review.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- The property must still look like exactly what this review last
  -- resolved to (or, if never applied, still be untouched).
  if p_corrected_disposition = 'new_lead' then
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
    -- property.status itself is enforced by the atomic UPDATE's own WHERE
    -- clause below (status = 'prospect') — not duplicated here, since
    -- that check needs to run at write time, not this moment.
  else
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
  end if;

  -- ------------------------------------------------------------------
  -- Atomic write: the WHERE clause below IS the concurrency control —
  -- checked by Postgres against the live row when the UPDATE actually
  -- runs, not by an app-level reread that happened moments (or a whole
  -- HTTP round trip) earlier. Zero rows matched means something else
  -- changed the property since we looked, above, in THIS SAME
  -- transaction — a real conflict, not a hypothetical one.
  -- ------------------------------------------------------------------
  if p_corrected_disposition = 'new_lead' then
    if v_property.is_dnc_locked then
      raise exception 'DNC_LOCKED: property is permanently read-only' using errcode = '22023';
    end if;
    update public.properties
    set status = 'new_lead', qualified_at = now(), qualified_by = v_actor, updated_at = now()
    where id = v_review.property_id and org_id = v_review.org_id
      and status = 'prospect' and is_dnc_locked = false
    returning id into v_updated_id;
    if v_updated_id is null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    update public.properties
    set outreach_dispo = p_corrected_disposition, follow_up_at = null, updated_at = now()
    where id = v_review.property_id and org_id = v_review.org_id
      and outreach_dispo is not distinct from v_property.outreach_dispo
    returning id into v_updated_id;
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
        -- Any OTHER error still propagates and rolls back the whole
        -- correction, rather than silently swallowing something real.
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
      human_reviewed_by = coalesce(human_reviewed_by, v_actor)
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

revoke all on function public.fn_apply_and_record_ai_disposition_review_correction(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_apply_and_record_ai_disposition_review_correction(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_apply_and_record_jev_lead_decision_correction — same atomic
-- validate+write+audit pattern for opted_out/dnc corrections on
-- jev_lead_decisions (new_lead/wrong_number/not_interested/nurture keep
-- using fn_correct_jev_lead_decision, which already writes them
-- directly and atomically — never had this bug).
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

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.is_training, p.homeowner_contact_id
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_property.is_training then
    raise exception 'Customer actions are unavailable for an internal training lead.' using errcode = '22023';
  end if;

  -- Exact-repeat detection — same rationale as the ai_disposition_review
  -- variant above.
  if v_decision.resolved_outcome = p_corrected_outcome and v_property.outreach_dispo = p_corrected_outcome then
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
  returning id into v_updated_id;
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
      -- Same tolerance as the ai_disposition_review variant above: a
      -- 'dnc' write can cascade-lock the contact before this statement
      -- runs — already suppressed by that lock. Any other error still
      -- propagates.
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
      human_reviewed_by = coalesce(human_reviewed_by, v_actor)
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

commit;
