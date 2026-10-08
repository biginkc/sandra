-- 20261008280200_wrong_number_all_confirm_suppresses.sql
-- Jarrad (2026-10-07): no automated DNC decisions. A model's "wrong number for
-- every property" (scope = all) now only marks the property wrong_number and
-- holds; the phone-wide suppression happens when a human CONFIRMS the review.
--   1. ai_disposition_reviews.wrong_scope records the model's scope.
--   2. fn_confirm_ai_disposition_review records the durable suppression
--      obligation (ledger row + hold pointer) for a confirmed wrong_number
--      with wrong_scope = 'all', in BOTH the deferred and the already-applied
--      branch, exactly like opted_out/dnc.
--   3. fn_list_outstanding_suppression_obligations (the sweeper feed) includes
--      those reviews.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.ai_disposition_reviews
  add column if not exists wrong_scope text;
alter table public.ai_disposition_reviews
  drop constraint if exists ai_disposition_reviews_wrong_scope_check;
alter table public.ai_disposition_reviews
  add constraint ai_disposition_reviews_wrong_scope_check
  check (wrong_scope is null or (wrong_scope in ('this_property', 'all') and disposition = 'wrong_number'));
comment on column public.ai_disposition_reviews.wrong_scope is
  'The model''s wrong-number scope. all = a human confirming the review must suppress the phone everywhere.';

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
  v_keep_hold boolean;
  v_phone_wide boolean;
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

  select p.outreach_dispo, p.homeowner_contact_id, p.decision_context_revision,
         p.last_ai_escalation_reason
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

  -- Phone-wide suppression is a human decision for: opted_out, dnc, and a
  -- wrong_number the model scoped to every property (wrong_scope = 'all').
  v_phone_wide := v_review.disposition in ('opted_out', 'dnc')
    or (v_review.disposition = 'wrong_number' and v_review.wrong_scope = 'all');

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

    -- An existing suppression_incomplete pointer belongs to OTHER reviews whose
    -- phone suppression is still outstanding. Confirming this review must not
    -- drop it (nor the attention flag it drives); the merge below and the clear
    -- function decide, under this same lock, when it may go away.
    v_keep_hold := v_property.last_ai_escalation_reason is not null
      and (v_property.last_ai_escalation_reason = 'suppression_incomplete'
        or left(v_property.last_ai_escalation_reason, length('suppression_incomplete:')) = 'suppression_incomplete:');

    update public.properties
    set outreach_dispo = v_review.disposition,
        needs_human_attention = v_keep_hold,
        last_ai_escalation_reason = case when v_keep_hold then v_property.last_ai_escalation_reason else null end,
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

    -- Durable obligation: phone-level suppression runs in the app AFTER this
    -- transaction commits. Record it here, atomically with the confirm, so a
    -- process death cannot lose it. Same row shape the app failure path writes.
    if v_phone_wide then
      insert into public.lead_events (
        org_id, property_id, actor_type, event_type, payload,
        source_type, source_id
      ) values (
        v_review.org_id, v_review.property_id, 'system', 'suppression_incomplete',
        jsonb_build_object('reviewId', v_review.id),
        'ai_disposition_reviews', v_review.id
      )
      on conflict (source_type, source_id) where source_id is not null do nothing;

      perform 1
      from public.fn_merge_suppression_incomplete_pointer(
        p_property_id => v_review.property_id,
        p_ids => array[v_review.id],
        p_hint_id => v_review.id
      );
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

  -- Applied wrong_number scoped to all: the disposition is already on the
  -- property, but the phone-wide suppression was deliberately NOT done by the
  -- model. Record the durable obligation here (same transaction); the app
  -- suppresses the phone and discharges it. The merge replaces the
  -- jev_wrong_number_all_needs_confirm hold with the suppression pointer, which
  -- the discharge clears.
  if v_phone_wide then
    insert into public.lead_events (
      org_id, property_id, actor_type, event_type, payload,
      source_type, source_id
    ) values (
      v_review.org_id, v_review.property_id, 'system', 'suppression_incomplete',
      jsonb_build_object('reviewId', v_review.id),
      'ai_disposition_reviews', v_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;

    perform 1
    from public.fn_merge_suppression_incomplete_pointer(
      p_property_id => v_review.property_id,
      p_ids => array[v_review.id],
      p_hint_id => v_review.id
    );
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

create or replace function public.fn_list_outstanding_suppression_obligations(
  p_older_than_seconds integer default 120,
  p_limit integer default 25
)
returns table(review_id uuid, property_id uuid, org_id uuid, reviewed_by uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.property_id, r.org_id, r.reviewed_by
  from public.lead_events le
  join public.ai_disposition_reviews r on r.id = le.source_id
  left join public.suppression_obligation_attempts att on att.review_id = r.id
  where le.event_type = 'suppression_incomplete'
    and le.source_type = 'ai_disposition_reviews'
    and le.created_at < now() - make_interval(secs => greatest(p_older_than_seconds, 0))
    and r.status = 'confirmed'
    and (r.disposition in ('opted_out', 'dnc')
         or (r.disposition = 'wrong_number' and r.wrong_scope = 'all'))
    and (
      att.review_id is null
      or att.last_attempt_at + public.fn_suppression_retry_backoff(att.attempt_count) <= now()
    )
    and not exists (
      select 1 from public.lead_events ok
      where ok.event_type = 'suppression_retried_ok'
        and ok.source_type = 'ai_disposition_reviews.suppression_retried'
        and ok.source_id = le.source_id
    )
  -- Rotating order (changes every 10 minutes) so rows that keep failing cannot
  -- permanently occupy the front of a bounded batch.
  order by hashtext(r.id::text || (extract(epoch from now())::bigint / 600)::text), r.id
  limit least(greatest(p_limit, 1), 100);
$$;

revoke all on function public.fn_list_outstanding_suppression_obligations(integer, integer) from public, anon, authenticated;
grant execute on function public.fn_list_outstanding_suppression_obligations(integer, integer) to service_role;

notify pgrst, 'reload schema';

commit;
