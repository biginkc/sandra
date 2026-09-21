-- Root final-review finding (P1, jev-root-final-review.md, 2026-09-20):
-- for wrong_number/not_interested/opted_out, `fn_apply_ai_disposition_with_review`
-- writes properties.outreach_dispo IMMEDIATELY when it creates the pending
-- review row — the ONLY thing a below-threshold Jev decision skipped was
-- the auto-accept step (flipping status to auto_accepted), never the
-- disposition write itself. That is backwards: "below threshold routes to
-- Needs a decision" must mean the property is UNCHANGED until a human
-- confirms, not merely "unacknowledged."
--
-- dnc already has exactly the right shape for this
-- (fn_propose_ai_dnc_suppression_review, 20260920120000): the review row
-- is created with dispo_applied=false and properties.outreach_dispo is
-- never written until fn_confirm_ai_disposition_review applies it. This
-- migration extends that SAME deferred-write mechanism to
-- wrong_number/not_interested/opted_out — dnc's own RPC is untouched
-- (it also applies phone suppression immediately, which is Jarrad's
-- explicit, already-reviewed "Option B" ruling specific to dnc/legal
-- language; that is NOT extended here — a below-threshold Jev
-- classification of opted_out is a model inference, not the deterministic
-- STOP-keyword path, so it gets zero suppression and zero disposition
-- write until a human confirms, per root's "avoid disposition/promotion/
-- suppression changes except independently required deterministic
-- STOP/legal safety handling").
--
-- fn_confirm_ai_disposition_review and fn_correct_ai_disposition_review /
-- fn_record_ai_disposition_review_correction already handle
-- dispo_applied=false generically (not dnc-specifically) — confirmed by
-- reading their bodies before writing this migration — so no change is
-- needed there.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

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

commit;
