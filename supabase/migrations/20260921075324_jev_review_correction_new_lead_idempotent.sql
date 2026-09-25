-- Fable production blocker:
--
-- fn_apply_and_record_ai_disposition_review_correction's new_lead write
-- unconditionally required status = 'prospect'. On a property already
-- status = 'new_lead' with a pending review (dispo_applied = false —
-- the earlier defense-in-depth check for that branch only requires
-- outreach_dispo to be null, which it is right after promotion), the
-- UPDATE ... where status = 'prospect' matches zero rows and the
-- function raises STALE_STATE for a legitimate re-correction to
-- new_lead. The same property can reach status = 'new_lead' again via
-- an unrelated correction chain (new_lead -> opted_out -> new_lead),
-- reproducing the same failure.
--
-- Fixed to match fn_correct_jev_lead_decision's existing idempotent
-- handling: accept status in ('prospect', 'new_lead'), only perform the
-- promotion write when still 'prospect', and reuse the property's
-- current revision when it is already 'new_lead'. The DNC lock check,
-- tenant auth, exact decision_context_revision gate, and the
-- property-before-review lock order are all unchanged.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

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
    -- Fable fix: a property that is already new_lead (e.g. promoted by
    -- an earlier, unrelated decision, or via a prior new_lead ->
    -- opted_out -> new_lead correction chain) is a legitimate target
    -- for this review to record new_lead against — idempotently skip
    -- the status write and reuse the current revision, matching
    -- fn_correct_jev_lead_decision's existing handling of the same
    -- case. Anything other than prospect/new_lead is still stale.
    if v_property.status not in ('prospect', 'new_lead') then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
    if v_property.status is distinct from 'new_lead' then
      update public.properties
      set status = 'new_lead', qualified_at = now(), qualified_by = v_actor, updated_at = now()
      where id = v_review.property_id and org_id = v_review.org_id
        and status = 'prospect' and is_dnc_locked = false
      returning id, decision_context_revision into v_updated_id, v_new_revision;
      if v_updated_id is null then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
    else
      v_updated_id := v_review.property_id;
      v_new_revision := v_property.decision_context_revision;
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
      'applied_via', case when p_corrected_disposition = 'new_lead' then 'qualifyProperty' else 'setOutreachDispo' end
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
  from public, anon;
grant execute on function public.fn_apply_and_record_ai_disposition_review_correction(uuid, text, text) to authenticated;

commit;
