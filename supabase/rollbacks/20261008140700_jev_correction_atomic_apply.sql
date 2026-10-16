-- Rollback for 20261008140700_jev_correction_atomic_apply.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration dropped: put the prior version back first (triggers below may point at them).
-- fn_begin_ai_disposition_review_correction(uuid, text): re-create (dropped by this migration) from 20261008140300_jev_review_taxonomy_and_marking.sql
create or replace function public.fn_begin_ai_disposition_review_correction(
  p_review_id uuid,
  p_corrected_disposition text
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

  select p.status, p.outreach_dispo, p.is_dnc_locked
  into v_property
  from public.properties p
  where p.id = v_review.property_id and p.org_id = v_review.org_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- trg_properties_supersede_ai_disposition_reviews auto-supersedes any
  -- pending review the instant properties.outreach_dispo changes — which
  -- includes THIS correction's own sanctioned setOutreachDispo call, if a
  -- prior attempt got that far before its record step failed/was never
  -- reached. That self-caused supersede (superseded_reason =
  -- 'property_outcome_changed' AND outreach_dispo already equals what
  -- this correction asked for) is a retry, not staleness. Any other
  -- superseded review — a genuine new Jev decision, or someone else's
  -- write to a different value — is real staleness.
  if v_review.status = 'superseded'
    and not (
      v_review.superseded_reason = 'property_outcome_changed'
      and p_corrected_disposition <> 'new_lead'
      and v_property.outreach_dispo is not distinct from p_corrected_disposition
    )
  then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Same staleness pre-check as fn_correct_ai_disposition_review: the
  -- property must still look like exactly what this review last
  -- resolved to (or, if never applied, still be untouched) — OR already
  -- match the outcome THIS correction is asking for, which means a
  -- prior attempt's sanctioned op already ran and only the record step
  -- failed/was never reached; that is a retry, not staleness, and must
  -- be allowed through so fn_record_*_correction can pick it up.
  if p_corrected_disposition = 'new_lead' then
    -- new_lead never touches outreach_dispo, so a partial-retry
    -- shortcut on that column doesn't apply here.
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
  else
    if v_review.status = 'pending' and v_review.dispo_applied then
      if v_property.outreach_dispo is distinct from v_review.disposition
        and v_property.outreach_dispo is distinct from p_corrected_disposition
      then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
    elsif v_review.status = 'pending' and not v_review.dispo_applied then
      if v_property.outreach_dispo is not null
        and v_property.outreach_dispo is distinct from p_corrected_disposition
      then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
    elsif v_property.outreach_dispo is distinct from coalesce(v_review.corrected_disposition, v_review.disposition)
      and v_property.outreach_dispo is distinct from p_corrected_disposition
    then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  return jsonb_build_object(
    'reviewId', v_review.id,
    'propertyId', v_review.property_id,
    'orgId', v_review.org_id,
    'isDncLocked', coalesce(v_property.is_dnc_locked, false)
  );
end;
$$;
revoke all on function public.fn_begin_ai_disposition_review_correction(uuid, text)
  from public, anon, service_role;
grant execute on function public.fn_begin_ai_disposition_review_correction(uuid, text) to authenticated;
-- fn_record_ai_disposition_review_correction(uuid, text, text): re-create (dropped by this migration) from 20261008140300_jev_review_taxonomy_and_marking.sql
create or replace function public.fn_record_ai_disposition_review_correction(
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
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_disposition not in ('new_lead', 'opted_out', 'dnc') then
    -- The other three targets (wrong_number/not_interested/nurture) go
    -- through fn_correct_ai_disposition_review, which both writes and
    -- records atomically — this RPC is only for the sanctioned-operation
    -- targets that can't be written from SQL alone.
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_review from public.ai_disposition_reviews where id = p_review_id for update;
  if not found then
    raise exception 'REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo
  into v_property
  from public.properties p
  where p.id = v_review.property_id and p.org_id = v_review.org_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Truthful recording only: the property must actually be in the state
  -- this correction claims, right now — not "close enough"
  -- (already_qualified could mean any later status, not specifically
  -- new_lead; a racing write could have moved outreach_dispo again since
  -- the sanctioned operation ran).
  if p_corrected_disposition = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is distinct from p_corrected_disposition then
      raise exception 'STALE_STATE' using errcode = '40001';
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
        when 'new_lead' then 'qualifyProperty'
        else 'setOutreachDispo'
      end
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'reviewId', v_review.id,
    'correctedDisposition', p_corrected_disposition
  );
end;
$$;
revoke all on function public.fn_record_ai_disposition_review_correction(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_record_ai_disposition_review_correction(uuid, text, text) to authenticated;
-- fn_begin_jev_lead_decision_correction(uuid, text): re-create (dropped by this migration) from 20261008140300_jev_review_taxonomy_and_marking.sql
create or replace function public.fn_begin_jev_lead_decision_correction(
  p_decision_id uuid,
  p_corrected_outcome text
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
  if v_decision.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Same staleness pre-check as fn_correct_jev_lead_decision — except a
  -- pending decision whose property already shows EXACTLY the outcome
  -- this correction is asking for is treated as a retry (a prior
  -- attempt's sanctioned op already ran and only the record step
  -- failed/was never reached), not staleness.
  if v_decision.status = 'pending' then
    if v_property.status is distinct from 'prospect'
      or (v_property.outreach_dispo is not null and v_property.outreach_dispo is distinct from p_corrected_outcome)
    then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_decision.resolved_outcome = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is distinct from v_decision.resolved_outcome
      and v_property.outreach_dispo is distinct from p_corrected_outcome
    then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  return jsonb_build_object(
    'decisionId', v_decision.id,
    'propertyId', v_decision.property_id,
    'orgId', v_decision.org_id,
    'isDncLocked', coalesce(v_property.is_dnc_locked, false)
  );
end;
$$;
revoke all on function public.fn_begin_jev_lead_decision_correction(uuid, text)
  from public, anon, service_role;
grant execute on function public.fn_begin_jev_lead_decision_correction(uuid, text) to authenticated;
-- fn_record_jev_lead_decision_correction(uuid, text, text): re-create (dropped by this migration) from 20261008140300_jev_review_taxonomy_and_marking.sql
create or replace function public.fn_record_jev_lead_decision_correction(
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

  select p.outreach_dispo into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_property.outreach_dispo is distinct from p_corrected_outcome then
    raise exception 'STALE_STATE' using errcode = '40001';
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
    'resolvedOutcome', p_corrected_outcome
  );
end;
$$;
revoke all on function public.fn_record_jev_lead_decision_correction(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_record_jev_lead_decision_correction(uuid, text, text) to authenticated;

-- Functions this migration created (no prior version): drop.
drop function if exists public.fn_apply_and_record_ai_disposition_review_correction(uuid, text, text);
drop function if exists public.fn_apply_and_record_jev_lead_decision_correction(uuid, text, text);

commit;
