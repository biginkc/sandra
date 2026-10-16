-- Rollback for 20261008140900_jev_decision_context_gaps.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration dropped: put the prior version back first (triggers below may point at them).
-- jev_bump_decision_context_revision_on_inbound(): re-create (dropped by this migration) from 20261008140800_jev_decision_context_revision.sql
create or replace function public.jev_bump_decision_context_revision_on_inbound()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.direction = 'inbound' and new.channel = 'sms' and new.property_id is not null then
    update public.properties
    set decision_context_revision = decision_context_revision + 1
    where id = new.property_id;
  end if;
  return new;
end;
$$;
-- fn_apply_ai_disposition_with_review(uuid, uuid, uuid, text, text): re-create (dropped by this migration) from 20260827110000_ai_disposition_reviews.sql
create or replace function public.fn_apply_ai_disposition_with_review(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_disposition text,
  p_ai_reason text
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

  select p.org_id, p.outreach_dispo, p.needs_human_attention
  into v_property
  from public.properties p
  where p.id = p_property_id
    and p.org_id = v_message.org_id
  for update;

  if not found then
    raise exception 'property does not match inbound SMS organization'
      using errcode = '23514';
  end if;

  -- The property is the first lock in every apply/confirm transition. Recheck
  -- the idempotency key only after that lock so a concurrent retry observes
  -- the first transaction's committed review instead of racing its unique
  -- constraint.
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
      when 'dnc' then 4
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
revoke all on function public.fn_apply_ai_disposition_with_review(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.fn_apply_ai_disposition_with_review(
  uuid, uuid, uuid, text, text
) to service_role;
-- fn_propose_deferred_ai_disposition_review(uuid, uuid, uuid, text, text): re-create (dropped by this migration) from 20261008140400_jev_deferred_disposition_proposal.sql
create or replace function public.fn_propose_deferred_ai_disposition_review(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_disposition text,
  p_ai_reason text
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

  if p_disposition not in ('wrong_number', 'not_interested', 'opted_out') then
    -- dnc keeps fn_propose_ai_dnc_suppression_review; this RPC never
    -- handles dnc.
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

  select p.org_id, p.outreach_dispo, p.needs_human_attention
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

  -- Same terminal/severity guard fn_apply_ai_disposition_with_review uses
  -- — a proposal must never silently downgrade a more specific state
  -- that already landed via another path (e.g. proposing not_interested
  -- when the property is already dnc). This RPC never writes
  -- outreach_dispo itself either way; the check only decides whether it
  -- is even worth proposing.
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

  -- Mark needs_human_attention so this surfaces for review WITHOUT
  -- touching outreach_dispo — the entire point of this RPC. No
  -- suppression side effect either (unlike dnc's Option B): a
  -- below-threshold Jev opted_out is a model inference, not the
  -- deterministic STOP-keyword path.
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
    disposition,
    ai_reason,
    dispo_applied
  ) values (
    v_message.org_id,
    p_property_id,
    p_conversation_id,
    p_source_inbound_message_id,
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
revoke all on function public.fn_propose_deferred_ai_disposition_review(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.fn_propose_deferred_ai_disposition_review(
  uuid, uuid, uuid, text, text
) to service_role;
-- fn_propose_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer): re-create (dropped by this migration) from 20261008140600_jev_lead_decision_threshold_version.sql
create or replace function public.fn_propose_jev_lead_decision(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_classification_run_id uuid,
  p_outcome text,
  p_native_confidence numeric,
  p_threshold_at_decision numeric,
  p_threshold_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message record;
  v_org_id uuid;
  v_existing public.jev_lead_decisions%rowtype;
  v_pending public.jev_lead_decisions%rowtype;
  v_row public.jev_lead_decisions%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome not in ('new_lead', 'nurture') then
    raise exception 'unsupported outcome for jev_lead_decisions: %', p_outcome
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
  v_org_id := v_message.org_id;

  select * into v_existing
  from public.jev_lead_decisions d
  where d.source_inbound_message_id = p_source_inbound_message_id;
  if found then
    return jsonb_build_object('status', 'replayed', 'decisionId', v_existing.id);
  end if;

  select d.* into v_pending
  from public.jev_lead_decisions d
  where d.org_id = v_org_id
    and d.property_id = p_property_id
    and d.status = 'pending'
  for update;

  if v_pending.id is not null then
    update public.jev_lead_decisions
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'new_ai_decision'
    where id = v_pending.id;
  end if;

  insert into public.jev_lead_decisions (
    org_id, property_id, conversation_id, source_inbound_message_id,
    classification_run_id, proposed_outcome, native_confidence,
    threshold_at_decision, threshold_version
  ) values (
    v_org_id, p_property_id, p_conversation_id, p_source_inbound_message_id,
    p_classification_run_id, p_outcome, p_native_confidence,
    p_threshold_at_decision, p_threshold_version
  )
  returning * into v_row;

  return jsonb_build_object('status', 'proposed', 'decisionId', v_row.id);
end;
$$;
revoke all on function public.fn_propose_jev_lead_decision(
  uuid, uuid, uuid, uuid, text, numeric, numeric, integer
) from public, anon, authenticated;
grant execute on function public.fn_propose_jev_lead_decision(
  uuid, uuid, uuid, uuid, text, numeric, numeric, integer
) to service_role;
-- fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer): re-create (dropped by this migration) from 20261008140600_jev_lead_decision_threshold_version.sql
create or replace function public.fn_auto_apply_jev_lead_decision(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_classification_run_id uuid,
  p_outcome text,
  p_native_confidence numeric,
  p_threshold_at_decision numeric,
  p_threshold_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message record;
  v_org_id uuid;
  v_existing public.jev_lead_decisions%rowtype;
  v_pending public.jev_lead_decisions%rowtype;
  v_row public.jev_lead_decisions%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome not in ('new_lead', 'nurture') then
    raise exception 'unsupported outcome for jev_lead_decisions: %', p_outcome
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
  v_org_id := v_message.org_id;

  select * into v_existing
  from public.jev_lead_decisions d
  where d.source_inbound_message_id = p_source_inbound_message_id;
  if found then
    return jsonb_build_object('status', 'replayed', 'decisionId', v_existing.id);
  end if;

  select d.* into v_pending
  from public.jev_lead_decisions d
  where d.org_id = v_org_id
    and d.property_id = p_property_id
    and d.status = 'pending'
  for update;

  if v_pending.id is not null then
    update public.jev_lead_decisions
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'new_ai_decision'
    where id = v_pending.id;
  end if;

  insert into public.jev_lead_decisions (
    org_id, property_id, conversation_id, source_inbound_message_id,
    classification_run_id, proposed_outcome, native_confidence,
    threshold_at_decision, threshold_version, status, resolved_outcome, resolved_at
  ) values (
    v_org_id, p_property_id, p_conversation_id, p_source_inbound_message_id,
    p_classification_run_id, p_outcome, p_native_confidence,
    p_threshold_at_decision, p_threshold_version, 'confirmed', p_outcome, now()
  )
  returning * into v_row;

  return jsonb_build_object('status', 'confirmed', 'decisionId', v_row.id);
end;
$$;
revoke all on function public.fn_auto_apply_jev_lead_decision(
  uuid, uuid, uuid, uuid, text, numeric, numeric, integer
) from public, anon, authenticated;
grant execute on function public.fn_auto_apply_jev_lead_decision(
  uuid, uuid, uuid, uuid, text, numeric, numeric, integer
) to service_role;
-- fn_propose_ai_dnc_suppression_review(uuid, uuid, uuid, text): re-create (dropped by this migration) from 20260920120000_sms_classification_runs.sql
create or replace function public.fn_propose_ai_dnc_suppression_review(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_ai_reason text
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required'
      using errcode = '42501';
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

  select p.org_id, p.outreach_dispo, p.needs_human_attention
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

  if v_property.outreach_dispo = 'dnc' then
    -- Already dnc (e.g. a prior confirmed review) — nothing left to
    -- propose.
    return jsonb_build_object('status', 'already_terminal');
  end if;

  select review.*
  into v_pending_review
  from public.ai_disposition_reviews review
  where review.org_id = v_message.org_id
    and review.conversation_id = p_conversation_id
    and review.status = 'pending'
  for update;

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
        'replacement_disposition', 'dnc',
        'reason', 'new_ai_decision',
        'source_inbound_message_id', v_pending_review.source_inbound_message_id
      ),
      'ai_disposition_reviews.superseded',
      v_pending_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;
  end if;

  -- Mark needs_human_attention so this surfaces for review, WITHOUT
  -- touching outreach_dispo — that is the entire point of this RPC.
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
    disposition,
    ai_reason,
    dispo_applied
  ) values (
    v_message.org_id,
    p_property_id,
    p_conversation_id,
    p_source_inbound_message_id,
    'dnc',
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
      'disposition', 'dnc',
      'review_id', v_review.id,
      'reason', btrim(p_ai_reason),
      'source_inbound_message_id', p_source_inbound_message_id,
      'note', 'suppression already applied by caller; outreach_dispo write deferred to human confirmation'
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
revoke all on function public.fn_propose_ai_dnc_suppression_review(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.fn_propose_ai_dnc_suppression_review(
  uuid, uuid, uuid, text
) to service_role;

-- Triggers
-- trigger trg_messages_bump_decision_context_revision on messages: restore prior definition
drop trigger if exists trg_messages_bump_decision_context_revision on public.messages;
create trigger trg_messages_bump_decision_context_revision
  after insert on public.messages
  for each row execute function public.jev_bump_decision_context_revision_on_inbound();
-- trigger trg_tasks_bump_decision_context_revision on tasks: restore prior definition
drop trigger if exists trg_tasks_bump_decision_context_revision on public.tasks;
create trigger trg_tasks_bump_decision_context_revision
  after insert on public.tasks
  for each row execute function public.jev_bump_decision_context_revision_on_appointment();
-- trigger trg_properties_bump_decision_context_revision on properties: restore prior definition
drop trigger if exists trg_properties_bump_decision_context_revision on public.properties;
create trigger trg_properties_bump_decision_context_revision
  before update of outreach_dispo, status, homeowner_contact_id, qualified_at
  on public.properties
  for each row execute function public.jev_bump_decision_context_revision();

-- Functions this migration created (no prior version): drop.
drop function if exists public.jev_bump_decision_context_revision_on_message_activity();
drop function if exists public.fn_apply_ai_disposition_with_review(uuid, uuid, uuid, text, text, bigint);
drop function if exists public.fn_propose_deferred_ai_disposition_review(uuid, uuid, uuid, text, text, bigint);
drop function if exists public.fn_propose_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer, bigint);
drop function if exists public.fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer, bigint);
drop function if exists public.fn_propose_ai_dnc_suppression_review(uuid, uuid, uuid, text, bigint);

commit;
