-- Rollback for 20261008140800_jev_decision_context_revision.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Triggers
drop trigger if exists trg_ai_disposition_reviews_capture_revision on public.ai_disposition_reviews;
drop trigger if exists trg_jev_lead_decisions_capture_revision on public.jev_lead_decisions;
drop trigger if exists trg_properties_bump_decision_context_revision on public.properties;
drop trigger if exists trg_messages_bump_decision_context_revision on public.messages;
drop trigger if exists trg_tasks_bump_decision_context_revision on public.tasks;

-- Functions this migration created (no prior version): drop.
drop function if exists public.jev_capture_decision_context_revision();
drop function if exists public.jev_bump_decision_context_revision();
drop function if exists public.jev_bump_decision_context_revision_on_inbound();
drop function if exists public.jev_bump_decision_context_revision_on_appointment();

-- Functions this migration replaced: restore the prior body (and grants).
-- fn_apply_and_record_ai_disposition_review_correction(uuid, text, text): restore body from 20261008140700_jev_correction_atomic_apply.sql
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
-- fn_apply_and_record_jev_lead_decision_correction(uuid, text, text): restore body from 20261008140700_jev_correction_atomic_apply.sql
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
-- fn_correct_ai_disposition_review(uuid, text, text): restore body from 20261008140200_jev_ai_disposition_review_correction.sql
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
  if v_review.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  select p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention
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
  if v_review.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- What did this review's most recent resolution actually write?
  -- corrected_disposition if it's been corrected before; else disposition
  -- itself, but only if that write already landed (dispo_applied=true —
  -- always true except an unconfirmed dnc Option B row).
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
    -- Nothing written yet by this review (unconfirmed dnc proposal) —
    -- outreach_dispo must still be whatever it was before Jev's
    -- proposal, i.e. untouched by anything else since.
    if v_property.outreach_dispo is not null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  if v_property.outreach_dispo is distinct from p_corrected_disposition
     and v_property.outreach_dispo in ('opted_out', 'dnc', 'bad_number', 'callback_requested', 'booked_appointment')
  then
    -- Unlike fn_apply_ai_disposition_with_review's severity ordering
    -- (which guards an AUTOMATED write from silently downgrading a case
    -- a human may have already escalated), a human correction has no
    -- such ordering among the three allowed targets themselves — the
    -- human reviewing this IS the authority making the call, and
    -- wrong_number/not_interested/nurture are lateral alternatives, not
    -- a severity ladder. Only block writing over something outside the
    -- allowed target set entirely (dnc/opted_out/etc — already more
    -- serious or side-effect-bearing states this RPC must never touch).
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Astra-pattern ordering (mirrors fn_confirm_ai_disposition_review's
  -- unapplied-dnc branch, 20260920120000_sms_classification_runs.sql):
  -- resolve THIS review row FIRST, while it may still be 'pending', so
  -- the existing trg_properties_supersede_ai_disposition_reviews trigger
  -- — which fires after the properties.outreach_dispo update below and
  -- marks every `pending` review for this property as superseded — no
  -- longer matches this row by the time it fires. A pending row that
  -- gets corrected is a resolved review (a human just decided the real
  -- outcome), not a superseded one.
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
    where id = v_review.property_id and org_id = v_review.org_id;
  end if;

  -- No source_type/source_id: a review can be corrected more than once,
  -- same reasoning as jev_lead_decisions' correction event.
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
revoke all on function public.fn_correct_ai_disposition_review(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_correct_ai_disposition_review(uuid, text, text) to authenticated;
-- fn_correct_jev_lead_decision(uuid, text, text): restore body from 20261008140100_jev_lead_decisions.sql
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
  if v_decision.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention
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
  if v_decision.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Staleness pre-check: the property must still look exactly like what
  -- THIS decision assumed. A still-pending row assumed "untouched"
  -- (prospect status, no dispo yet). An already-resolved row assumed
  -- exactly what it last wrote — new_lead resolved to a status change,
  -- everything else to an outreach_dispo write. Any mismatch means
  -- something newer (human, inbound, another system writer) already
  -- changed this property; fail clearly rather than overwrite it.
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
      where id = v_decision.property_id and org_id = v_decision.org_id;
    end if;
  else
    -- No severity ordering among wrong_number/not_interested/nurture here
    -- — unlike fn_apply_ai_disposition_with_review's AUTOMATED severity
    -- guard, a human correction has no such ladder among these three
    -- lateral alternatives; the human reviewing this is the authority.
    -- The staleness pre-check above already guarantees outreach_dispo is
    -- either null or exactly this decision's own resolved_outcome by
    -- this point, so dnc/opted_out can never appear here — this `in`
    -- check is defense-in-depth, not the primary guard.
    if v_property.outreach_dispo is distinct from p_corrected_outcome then
      if v_property.outreach_dispo in ('opted_out', 'dnc', 'bad_number', 'callback_requested', 'booked_appointment') then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
      update public.properties
      set outreach_dispo = p_corrected_outcome,
          needs_human_attention = false,
          last_ai_escalation_reason = null,
          updated_at = now()
      where id = v_decision.property_id and org_id = v_decision.org_id;
    end if;
  end if;

  update public.jev_lead_decisions
  set status = 'corrected',
      resolved_outcome = p_corrected_outcome,
      resolved_at = now(),
      resolved_by = v_actor,
      resolution_reason = nullif(btrim(p_reason), '')
  where id = v_decision.id;

  -- No source_type/source_id here (unlike confirm/propose above):
  -- lead_events enforces a unique (source_type, source_id) identity, but
  -- unlike "confirmed"/"superseded" — which happen at most once per
  -- row — a correction is explicitly allowed to happen more than once on
  -- the same decision (e.g. wrong_number -> nurture, then later
  -- nurture -> new_lead). Reusing decision.id as the dedup key would
  -- make every correction after the first fail on the unique index.
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
-- fn_confirm_ai_disposition_review(uuid): restore body from 20260920120000_sms_classification_runs.sql
create or replace function public.fn_confirm_ai_disposition_review(
  p_review_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_review public.ai_disposition_reviews%rowtype;
  v_outreach_dispo text;
begin
  if auth.uid() is null then
    raise exception 'signed-in user required'
      using errcode = '42501';
  end if;

  select review.*
  into v_review
  from public.ai_disposition_reviews review
  where review.id = p_review_id;

  if not found then
    raise exception 'AI disposition review not found'
      using errcode = 'P0002';
  end if;

  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'active organization access required'
      using errcode = '42501';
  end if;

  select p.outreach_dispo
  into v_outreach_dispo
  from public.properties p
  where p.id = v_review.property_id
    and p.org_id = v_review.org_id
  for update;

  if not found then
    raise exception 'AI disposition review property not found'
      using errcode = 'P0002';
  end if;

  select review.*
  into v_review
  from public.ai_disposition_reviews review
  where review.id = p_review_id
  for update;

  if not found then
    raise exception 'AI disposition review not found'
      using errcode = 'P0002';
  end if;

  if v_review.status <> 'pending' then
    return jsonb_build_object(
      'status', v_review.status,
      'reviewId', v_review.id
    );
  end if;

  -- Unapplied proposal (Jev-driven dnc, Option B): outreach_dispo was
  -- deliberately never written by the propose step. Write it now, as
  -- part of this human confirmation, instead of running the
  -- already-applied supersede-on-mismatch check below (which assumes
  -- outreach_dispo already reflects this review's disposition — for an
  -- unapplied row it never did, by design).
  if not v_review.dispo_applied then
    -- Astra PR review finding (2026-09-20, BLOCKING): the existing
    -- trigger `trg_properties_supersede_ai_disposition_reviews`
    -- (20260827110000) fires AFTER UPDATE OF outreach_dispo on
    -- properties and supersedes every `pending` review for that
    -- property/org — including this very row, if the property update
    -- ran first. That would flip this row to 'superseded' with
    -- superseded_reason set, and the very next statement here trying to
    -- set it to 'confirmed' would then violate
    -- ai_disposition_reviews_resolution_check (confirmed requires
    -- superseded_reason IS NULL). Order matters: resolve THIS review to
    -- 'confirmed' FIRST, while it's still 'pending' and this is the only
    -- statement touching it, so when the trigger fires off the property
    -- update below, its `where review.status = 'pending'` filter no
    -- longer matches this row at all.
    update public.ai_disposition_reviews
    set status = 'confirmed',
        resolved_at = now(),
        reviewed_by = auth.uid(),
        dispo_applied = true
    where id = v_review.id;

    update public.properties
    set outreach_dispo = v_review.disposition,
        needs_human_attention = false,
        last_ai_escalation_reason = null,
        updated_at = now()
    where id = v_review.property_id
      and org_id = v_review.org_id;

    insert into public.lead_events (
      org_id, property_id, actor_type, actor_id, event_type, payload,
      source_type, source_id
    ) values (
      v_review.org_id,
      v_review.property_id,
      'user',
      auth.uid(),
      'ai_dispo_review_confirmed',
      jsonb_build_object(
        'review_id', v_review.id,
        'disposition', v_review.disposition,
        'source_inbound_message_id', v_review.source_inbound_message_id,
        'note', 'deferred dispo write applied at confirmation'
      ),
      'ai_disposition_reviews.confirmed',
      v_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;

    return jsonb_build_object(
      'status', 'confirmed',
      'reviewId', v_review.id
    );
  end if;

  if v_outreach_dispo is distinct from v_review.disposition then
    update public.ai_disposition_reviews
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'property_outcome_changed'
    where id = v_review.id;

    insert into public.lead_events (
      org_id, property_id, actor_type, event_type, payload,
      source_type, source_id
    ) values (
      v_review.org_id,
      v_review.property_id,
      'system',
      'ai_dispo_review_superseded',
      jsonb_build_object(
        'review_id', v_review.id,
        'proposed_disposition', v_review.disposition,
        'replacement_disposition', v_outreach_dispo,
        'reason', 'property_outcome_changed',
        'source_inbound_message_id', v_review.source_inbound_message_id
      ),
      'ai_disposition_reviews.superseded',
      v_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;

    return jsonb_build_object(
      'status', 'superseded',
      'reviewId', v_review.id
    );
  end if;

  update public.ai_disposition_reviews
  set status = 'confirmed',
      resolved_at = now(),
      reviewed_by = auth.uid()
  where id = v_review.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    v_review.org_id,
    v_review.property_id,
    'user',
    auth.uid(),
    'ai_dispo_review_confirmed',
    jsonb_build_object(
      'review_id', v_review.id,
      'disposition', v_review.disposition,
      'source_inbound_message_id', v_review.source_inbound_message_id
    ),
    'ai_disposition_reviews.confirmed',
    v_review.id
  )
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return jsonb_build_object(
    'status', 'confirmed',
    'reviewId', v_review.id
  );
end;
$$;
revoke all on function public.fn_confirm_ai_disposition_review(uuid)
  from public, anon, service_role;
grant execute on function public.fn_confirm_ai_disposition_review(uuid)
  to authenticated;
-- fn_confirm_jev_lead_decision(uuid): restore body from 20261008140100_jev_lead_decisions.sql
create or replace function public.fn_confirm_jev_lead_decision(
  p_decision_id uuid
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

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention
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
    where id = v_decision.property_id and org_id = v_decision.org_id;
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
    where id = v_decision.property_id and org_id = v_decision.org_id;
  end if;

  update public.jev_lead_decisions
  set status = 'confirmed',
      resolved_outcome = v_decision.proposed_outcome,
      resolved_at = now(),
      resolved_by = v_actor
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

-- Tables / columns / constraints
alter table if exists public.properties drop column if exists decision_context_revision;
alter table if exists public.ai_disposition_reviews drop column if exists decision_context_revision;
alter table if exists public.jev_lead_decisions drop column if exists decision_context_revision;

commit;
