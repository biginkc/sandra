-- Rollback for 20261008300200: restores the 190000 confirm RPC and sweeper feed, drops wrong_scope.
begin;

drop function if exists public.fn_apply_ai_disposition_with_review(uuid, uuid, uuid, text, text, bigint, text);
create or replace function public.fn_apply_ai_disposition_with_review(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_disposition text,
  p_ai_reason text,
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message record;
  v_property record;
  v_existing_review public.ai_disposition_reviews%rowtype;
  v_pending_review public.ai_disposition_reviews%rowtype;
  v_review public.ai_disposition_reviews%rowtype;
  v_current_severity integer;
  v_next_severity integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required'
      using errcode = '42501';
  end if;

  if p_disposition not in ('wrong_number', 'not_interested', 'opted_out', 'dnc') then
    raise exception 'unsupported AI disposition: %', p_disposition
      using errcode = '22023';
  end if;
  if nullif(btrim(p_ai_reason), '') is null then
    raise exception 'AI disposition reason is required'
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

  if not exists (
    select 1
    from public.message_threads thread
    where thread.org_id = v_message.org_id
      and thread.property_id = p_property_id
      and thread.conversation_id = p_conversation_id
      and thread.channel = 'sms'
  ) then
    raise exception 'message thread does not match inbound SMS'
      using errcode = '23514';
  end if;

  select p.org_id, p.outreach_dispo, p.needs_human_attention, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = p_property_id
    and p.org_id = v_message.org_id
  for update;

  if not found then
    raise exception 'property does not match inbound SMS organization'
      using errcode = '23514';
  end if;

  select review.*
  into v_existing_review
  from public.ai_disposition_reviews review
  where review.source_inbound_message_id = p_source_inbound_message_id;

  if found then
    return jsonb_build_object(
      'status', 'replayed',
      'reviewId', v_existing_review.id,
      'reviewStatus', v_existing_review.status
    );
  end if;

  -- GAP 2: only enforced when the caller supplied one (Jev calls always
  -- do; legacy calls pass null and this is a no-op, unchanged behavior).
  if p_expected_revision is not null and v_property.decision_context_revision is distinct from p_expected_revision then
    raise exception 'STALE_DECISION_CONTEXT' using errcode = '40001';
  end if;

  select review.*
  into v_pending_review
  from public.ai_disposition_reviews review
  where review.org_id = v_message.org_id
    and review.conversation_id = p_conversation_id
    and review.status = 'pending'
  for update;

  if coalesce(v_property.needs_human_attention, false) then
    return jsonb_build_object('status', 'already_terminal');
  end if;

  if v_property.outreach_dispo is not distinct from p_disposition
    and v_pending_review.id is null
  then
    return jsonb_build_object('status', 'already_terminal');
  end if;

  if v_property.outreach_dispo is distinct from p_disposition then
    if p_disposition not in ('opted_out', 'dnc')
      and v_property.outreach_dispo in (
        'bad_number', 'nurture', 'callback_requested', 'booked_appointment'
      )
    then
      return jsonb_build_object('status', 'already_terminal');
    end if;

    v_current_severity := case v_property.outreach_dispo
      when 'not_interested' then 1
      when 'wrong_number' then 2
      when 'opted_out' then 3
      when 'dnc' then 4
      else 0
    end;
    v_next_severity := case p_disposition
      when 'not_interested' then 1
      when 'wrong_number' then 2
      when 'opted_out' then 3
    end;

    if v_next_severity < v_current_severity then
      return jsonb_build_object('status', 'already_terminal');
    end if;
  end if;

  if v_pending_review.id is not null then
    update public.ai_disposition_reviews
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'new_ai_decision'
    where id = v_pending_review.id;

    insert into public.lead_events (
      org_id, property_id, actor_type, event_type, payload,
      source_type, source_id
    ) values (
      v_message.org_id,
      p_property_id,
      'system',
      'ai_dispo_review_superseded',
      jsonb_build_object(
        'review_id', v_pending_review.id,
        'proposed_disposition', v_pending_review.disposition,
        'replacement_disposition', p_disposition,
        'reason', 'new_ai_decision',
        'source_inbound_message_id', v_pending_review.source_inbound_message_id
      ),
      'ai_disposition_reviews.superseded',
      v_pending_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;
  end if;

  if v_property.outreach_dispo is distinct from p_disposition then
    update public.properties
    set outreach_dispo = p_disposition,
        needs_human_attention = false,
        last_ai_escalation_reason = null,
        updated_at = now()
    where id = p_property_id
      and org_id = v_message.org_id;
  end if;

  insert into public.ai_disposition_reviews (
    org_id,
    property_id,
    conversation_id,
    source_inbound_message_id,
    disposition,
    ai_reason
  ) values (
    v_message.org_id,
    p_property_id,
    p_conversation_id,
    p_source_inbound_message_id,
    p_disposition,
    btrim(p_ai_reason)
  )
  returning * into v_review;

  insert into public.lead_events (
    org_id, property_id, actor_type, event_type, payload,
    source_type, source_id
  ) values (
    v_message.org_id,
    p_property_id,
    'ai',
    'dispo_set',
    jsonb_build_object(
      'from', v_property.outreach_dispo,
      'to', p_disposition,
      'review_id', v_review.id,
      'reason', btrim(p_ai_reason),
      'source_inbound_message_id', p_source_inbound_message_id
    ),
    'ai_disposition_reviews.applied',
    v_review.id
  );

  return jsonb_build_object(
    'status', 'applied',
    'reviewId', v_review.id,
    'reviewStatus', v_review.status
  );
end;
$$;
revoke all on function public.fn_apply_ai_disposition_with_review(uuid, uuid, uuid, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_apply_ai_disposition_with_review(uuid, uuid, uuid, text, text, bigint) to service_role;

drop function if exists public.fn_propose_deferred_ai_disposition_review(uuid, uuid, uuid, uuid, text, text, bigint, text);
create or replace function public.fn_propose_deferred_ai_disposition_review(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_classification_run_id uuid,
  p_disposition text,
  p_ai_reason text,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message record;
  v_run record;
  v_property record;
  v_existing_review public.ai_disposition_reviews%rowtype;
  v_pending_review public.ai_disposition_reviews%rowtype;
  v_review public.ai_disposition_reviews%rowtype;
  v_current_severity integer;
  v_next_severity integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required'
      using errcode = '42501';
  end if;

  if p_disposition not in ('wrong_number', 'not_interested', 'opted_out') then
    raise exception 'unsupported deferred AI disposition: %', p_disposition
      using errcode = '22023';
  end if;
  if nullif(btrim(p_ai_reason), '') is null then
    raise exception 'AI disposition reason is required'
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

  -- Tenant/identity integrity for the provenance link (mirrors
  -- fn_auto_apply_jev_lead_decision, 20261008141100): the cited run must
  -- really be the one that produced THIS disposition for THIS org/
  -- property/conversation/source message.
  select cr.org_id, cr.property_id, cr.conversation_id, cr.source_inbound_message_id,
         cr.provider, cr.resolved_outcome
  into v_run
  from public.sms_classification_runs cr
  where cr.id = p_classification_run_id;
  if not found
    or v_run.org_id is distinct from v_message.org_id
    or v_run.property_id is distinct from p_property_id
    or v_run.conversation_id is distinct from p_conversation_id
    or v_run.source_inbound_message_id is distinct from p_source_inbound_message_id
    or v_run.provider is distinct from 'jev'
    or v_run.resolved_outcome is distinct from p_disposition
  then
    raise exception 'classification_run_id does not match this proposal (org/property/conversation/source message/provider/outcome)'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.message_threads thread
    where thread.org_id = v_message.org_id
      and thread.property_id = p_property_id
      and thread.conversation_id = p_conversation_id
      and thread.channel = 'sms'
  ) then
    raise exception 'message thread does not match inbound SMS'
      using errcode = '23514';
  end if;

  select p.org_id, p.outreach_dispo, p.needs_human_attention, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = p_property_id
    and p.org_id = v_message.org_id
  for update;

  if not found then
    raise exception 'property does not match inbound SMS organization'
      using errcode = '23514';
  end if;

  select review.*
  into v_existing_review
  from public.ai_disposition_reviews review
  where review.source_inbound_message_id = p_source_inbound_message_id;

  if found then
    return jsonb_build_object(
      'status', 'replayed',
      'reviewId', v_existing_review.id,
      'reviewStatus', v_existing_review.status
    );
  end if;

  if v_property.decision_context_revision is distinct from p_expected_revision then
    raise exception 'STALE_DECISION_CONTEXT' using errcode = '40001';
  end if;

  select review.*
  into v_pending_review
  from public.ai_disposition_reviews review
  where review.org_id = v_message.org_id
    and review.conversation_id = p_conversation_id
    and review.status = 'pending'
  for update;

  if coalesce(v_property.needs_human_attention, false) then
    return jsonb_build_object('status', 'already_terminal');
  end if;

  if v_property.outreach_dispo is not distinct from p_disposition
    and v_pending_review.id is null
  then
    return jsonb_build_object('status', 'already_terminal');
  end if;

  if v_property.outreach_dispo is distinct from p_disposition then
    if p_disposition not in ('opted_out')
      and v_property.outreach_dispo in (
        'bad_number', 'nurture', 'callback_requested', 'booked_appointment'
      )
    then
      return jsonb_build_object('status', 'already_terminal');
    end if;

    v_current_severity := case v_property.outreach_dispo
      when 'not_interested' then 1
      when 'wrong_number' then 2
      when 'opted_out' then 3
      when 'dnc' then 4
      else 0
    end;
    v_next_severity := case p_disposition
      when 'not_interested' then 1
      when 'wrong_number' then 2
      when 'opted_out' then 3
    end;

    if v_next_severity < v_current_severity then
      return jsonb_build_object('status', 'already_terminal');
    end if;
  end if;

  if v_pending_review.id is not null then
    update public.ai_disposition_reviews
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'new_ai_decision'
    where id = v_pending_review.id;

    insert into public.lead_events (
      org_id, property_id, actor_type, event_type, payload,
      source_type, source_id
    ) values (
      v_message.org_id,
      p_property_id,
      'system',
      'ai_dispo_review_superseded',
      jsonb_build_object(
        'review_id', v_pending_review.id,
        'proposed_disposition', v_pending_review.disposition,
        'replacement_disposition', p_disposition,
        'reason', 'new_ai_decision',
        'source_inbound_message_id', v_pending_review.source_inbound_message_id
      ),
      'ai_disposition_reviews.superseded',
      v_pending_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;
  end if;

  update public.properties
  set needs_human_attention = true,
      updated_at = now()
  where id = p_property_id
    and org_id = v_message.org_id;

  insert into public.ai_disposition_reviews (
    org_id,
    property_id,
    conversation_id,
    source_inbound_message_id,
    classification_run_id,
    disposition,
    ai_reason,
    dispo_applied
  ) values (
    v_message.org_id,
    p_property_id,
    p_conversation_id,
    p_source_inbound_message_id,
    p_classification_run_id,
    p_disposition,
    btrim(p_ai_reason),
    false
  )
  returning * into v_review;

  insert into public.lead_events (
    org_id, property_id, actor_type, event_type, payload,
    source_type, source_id
  ) values (
    v_message.org_id,
    p_property_id,
    'ai',
    'dispo_proposed',
    jsonb_build_object(
      'disposition', p_disposition,
      'review_id', v_review.id,
      'reason', btrim(p_ai_reason),
      'source_inbound_message_id', p_source_inbound_message_id,
      'note', 'below-threshold Jev decision — outreach_dispo write deferred to human confirmation'
    ),
    'ai_disposition_reviews.proposed',
    v_review.id
  );

  return jsonb_build_object(
    'status', 'proposed',
    'reviewId', v_review.id,
    'reviewStatus', v_review.status
  );
end;
$$;
revoke all on function public.fn_propose_deferred_ai_disposition_review(uuid, uuid, uuid, uuid, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_propose_deferred_ai_disposition_review(uuid, uuid, uuid, uuid, text, text, bigint) to service_role;

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
    if v_review.disposition in ('opted_out', 'dnc') then
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
    and r.disposition in ('opted_out', 'dnc')
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

alter table public.ai_disposition_reviews drop constraint if exists ai_disposition_reviews_wrong_scope_check;
alter table public.ai_disposition_reviews drop column if exists wrong_scope;

notify pgrst, 'reload schema';

commit;
