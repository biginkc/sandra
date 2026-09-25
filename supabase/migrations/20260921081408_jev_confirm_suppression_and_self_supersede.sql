-- Astra production blockers 1 & 2 (2026-09-21):
--
-- 1. fn_confirm_ai_disposition_review's "unapplied proposal" branch
--    (dispo_applied = false — the below-threshold deferred/dnc proposal
--    path) writes properties.outreach_dispo directly on confirm, but
--    never runs the contact/phone SMS suppression that
--    fn_apply_and_record_ai_disposition_review_correction's non-new_lead
--    branch already runs for the exact same target dispositions
--    (opted_out, dnc). A below-threshold opted_out review, confirmed as-
--    is (never corrected), left the contact fully able to receive SMS.
--    Fixed by running the identical suppression block (same shared-
--    contact-safe guard: only flips a contact that isn't already
--    do_not_contact/sms_opted_out, same DNC_LOCKED tolerance) in that
--    branch, for the same non-new_lead dispositions.
--
-- 2. fn_apply_and_record_ai_disposition_review_correction writes
--    properties.outreach_dispo BEFORE resolving the review's own status.
--    trg_properties_supersede_ai_disposition_reviews fires on that write
--    and supersedes every 'pending' review on the property — including
--    the very row this function is in the middle of resolving, since
--    its status is still 'pending' at that instant. The function then
--    proceeds to also set corrected_disposition/dispo_applied/etc on
--    that same row, but its `status = case when status = 'pending' then
--    'confirmed' else status end` no longer matches (the trigger already
--    flipped it to 'superseded'), so the row is left "corrected" in
--    content but 'superseded' in status — and a later correction on it
--    raises STALE_STATE ("status = 'superseded'" check) instead of
--    idempotently succeeding.
--
--    Fixed with a transaction-local GUC identifying the review currently
--    being resolved, so the trigger's supersede sweep skips exactly that
--    row while still correctly superseding every OTHER pending review on
--    the property. Property-before-review lock order (20260921070947)
--    is unchanged — this only changes which rows the trigger's own
--    UPDATE touches, not any lock acquisition order.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.supersede_ai_disposition_reviews_on_outcome_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_resolving_review_id uuid;
begin
  if old.outreach_dispo is not distinct from new.outreach_dispo then
    return new;
  end if;

  -- Blocker 2: a review-resolution RPC that writes properties.outreach_dispo
  -- for the SAME review row it is in the middle of resolving sets this
  -- GUC first (set_config(..., true) — transaction-local, cleared at
  -- commit/rollback) so this trigger's own supersede sweep does not
  -- clobber that row's still-'pending' status mid-resolution. Any other
  -- pending review on the property is still superseded normally.
  begin
    v_resolving_review_id := nullif(current_setting('jev.resolving_review_id', true), '')::uuid;
  exception when others then
    v_resolving_review_id := null;
  end;

  with resolved as (
    update public.ai_disposition_reviews review
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'property_outcome_changed'
    where review.property_id = new.id
      and review.org_id = new.org_id
      and review.status = 'pending'
      and review.id is distinct from v_resolving_review_id
    returning review.id, review.org_id, review.property_id,
      review.disposition, review.source_inbound_message_id
  )
  insert into public.lead_events (
    org_id, property_id, actor_type, event_type, payload,
    source_type, source_id
  )
  select
    resolved.org_id,
    resolved.property_id,
    'system',
    'ai_dispo_review_superseded',
    jsonb_build_object(
      'review_id', resolved.id,
      'proposed_disposition', resolved.disposition,
      'replacement_disposition', new.outreach_dispo,
      'reason', 'property_outcome_changed',
      'source_inbound_message_id', resolved.source_inbound_message_id
    ),
    'ai_disposition_reviews.superseded',
    resolved.id
  from resolved
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return new;
end;
$$;

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

  -- Blocker 2 fix: identify this review to the supersede trigger BEFORE
  -- any write that could fire it, so it is skipped rather than
  -- self-superseded. Transaction-local (true) — cleared automatically at
  -- commit/rollback of this function's own transaction.
  perform set_config('jev.resolving_review_id', v_review.id::text, true);

  -- ------------------------------------------------------------------
  -- Atomic write: the WHERE clause below is the last-instant concurrency
  -- control for anything happening DURING this very function call (the
  -- revision check above already ruled out anything before it started).
  -- ------------------------------------------------------------------
  if p_corrected_disposition = 'new_lead' then
    if v_property.is_dnc_locked then
      raise exception 'DNC_LOCKED: property is permanently read-only' using errcode = '22023';
    end if;
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

-- Blocker 1: confirm's unapplied-proposal branch now applies the same
-- contact/phone suppression fn_apply_and_record_ai_disposition_review_correction
-- already applies for a non-new_lead target, for the same dispositions
-- (this branch only ever holds opted_out/dnc — dnc's suppression is
-- already applied by the caller before this proposal even exists, per
-- fn_propose_ai_dnc_suppression_review's doc comment, so the DNC_LOCKED
-- tolerance below covers that case; opted_out reaches confirm with the
-- contact NOT yet suppressed, which was the missing piece).
create or replace function public.fn_confirm_ai_disposition_review(p_review_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_review public.ai_disposition_reviews%rowtype;
  v_property record;
  v_new_revision bigint;
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

  select p.outreach_dispo, p.homeowner_contact_id, p.decision_context_revision
  into v_property
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

  if not v_review.dispo_applied then
    if v_property.decision_context_revision is distinct from v_review.decision_context_revision
      or v_property.outreach_dispo is not null
    then
      update public.ai_disposition_reviews
      set status = 'superseded',
          resolved_at = now(),
          superseded_reason = 'property_outcome_changed'
      where id = v_review.id;

      insert into public.lead_events (
        org_id, property_id, actor_type, event_type, payload,
        source_type, source_id
      ) values (
        v_review.org_id, v_review.property_id, 'system', 'ai_dispo_review_superseded',
        jsonb_build_object(
          'review_id', v_review.id,
          'proposed_disposition', v_review.disposition,
          'replacement_disposition', v_property.outreach_dispo,
          'reason', 'property_outcome_changed',
          'source_inbound_message_id', v_review.source_inbound_message_id
        ),
        'ai_disposition_reviews.superseded', v_review.id
      )
      on conflict (source_type, source_id) where source_id is not null do nothing;

      return jsonb_build_object('status', 'superseded', 'reviewId', v_review.id);
    end if;

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
      and org_id = v_review.org_id
    returning decision_context_revision into v_new_revision;

    update public.ai_disposition_reviews
    set decision_context_revision = v_new_revision
    where id = v_review.id;

    -- Blocker 1: mirror the correction path's contact/phone suppression
    -- for the same non-new_lead outcomes (opted_out, dnc) this branch
    -- can ever hold — same shared-contact-safe guard, same DNC_LOCKED
    -- tolerance for a phone already cascade-locked by a dnc write.
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

  if v_property.outreach_dispo is distinct from v_review.disposition
    or v_property.decision_context_revision is distinct from v_review.decision_context_revision
  then
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
        'replacement_disposition', v_property.outreach_dispo,
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

commit;
