-- Astra production blocker (2026-09-21):
--
-- fn_confirm_ai_disposition_review's unapplied-proposal branch
-- (20260921081408) runs contact/phone SMS suppression unconditionally
-- whenever the property has a homeowner_contact_id. But 20260921081409
-- extended the deferred-review universe to include not_interested and
-- wrong_number (dispo_applied = false, same branch). Confirming either
-- of those currently flips contacts.sms_opted_out = true, which is wrong
-- — only opted_out/dnc dispositions should ever suppress the contact.
--
-- Fixed by gating that suppression block on
-- v_review.disposition in ('opted_out', 'dnc'), matching the correction
-- RPC's own non-new_lead branch, which already only ever writes that
-- disposition set via CHECK constraints on corrected_disposition.
-- not_interested/wrong_number still get their property disposition
-- confirmed and the review resolved — only the contact-suppression side
-- effect is scoped down.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

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

    -- Fix: only opted_out/dnc suppress the contact/phone. not_interested
    -- and wrong_number confirm the property disposition but must never
    -- flip contacts.sms_opted_out.
    if v_review.disposition in ('opted_out', 'dnc')
      and v_property.homeowner_contact_id is not null
    then
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
