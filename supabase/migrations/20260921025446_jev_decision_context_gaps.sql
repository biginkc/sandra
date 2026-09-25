-- Root review of 8361775a (jev-root-revision-review.md, 2026-09-20):
-- two remaining gaps in the decision_context_revision mechanism.
--
-- GAP 1 — bump-trigger coverage was incomplete:
--   - `messages` only bumped on INBOUND. Outbound activity (a human or
--     system reply) is equally "newer thread activity" that can
--     invalidate a pending decision's context.
--   - `tasks` (appointments) only bumped on INSERT. A reschedule
--     (due_at/end_at), a reassignment (assignee_id), or a status change
--     (cancelled/completed) on an EXISTING appointment is just as
--     decision-relevant as booking a new one.
--   - `properties` never tracked human-takeover signals: an operator
--     claiming `assigned_user_id` or flipping `ai_responder_disabled`
--     (the per-property AI kill switch) means a human is now handling
--     this lead directly — a stale AI decision should not silently
--     apply over that. `needs_human_attention` stays deliberately
--     EXCLUDED — it churns on every escalation and would invalidate
--     pending decisions constantly for reasons unrelated to the actual
--     decision outcome ("without breaking system bookkeeping").
--
-- GAP 2 — the revision was captured at decision-ROW-creation time, which
-- happens AFTER the Jev HTTP call (real network latency) and after
-- `resolvePolicyOutcome`. A classification computed against context
-- that was ALREADY stale by the time evaluation even finished could
-- still get "blessed" with a fresh revision snapshot the moment its row
-- was inserted — the row would look perfectly fresh (nothing changed
-- SINCE it was created) even though the MODEL'S OWN INPUT was already
-- outdated. `dispatch-bridge.ts` now reads
-- `properties.decision_context_revision` BEFORE the context build and
-- the Jev HTTP call even start (`evaluationRevision`); every propose/
-- apply RPC below takes that value and enforces it against the row it
-- locks, at the actual moment of application — not merely at whatever
-- moment the audit row happens to be inserted.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ----------------------------------------------------------------------------
-- GAP 1a: outbound message activity.
-- ----------------------------------------------------------------------------
drop trigger if exists trg_messages_bump_decision_context_revision on public.messages;
drop function if exists public.jev_bump_decision_context_revision_on_inbound();

create or replace function public.jev_bump_decision_context_revision_on_message_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.channel = 'sms' and new.property_id is not null and new.direction in ('inbound', 'outbound') then
    update public.properties
    set decision_context_revision = decision_context_revision + 1
    where id = new.property_id;
  end if;
  return new;
end;
$$;

create trigger trg_messages_bump_decision_context_revision
  after insert on public.messages
  for each row execute function public.jev_bump_decision_context_revision_on_message_activity();

-- ----------------------------------------------------------------------------
-- GAP 1b: appointment reschedule/reassignment/status-change, not just
-- initial booking.
-- ----------------------------------------------------------------------------
drop trigger if exists trg_tasks_bump_decision_context_revision on public.tasks;

create trigger trg_tasks_bump_decision_context_revision
  after insert or update of due_at, end_at, assignee_id, status
  on public.tasks
  for each row execute function public.jev_bump_decision_context_revision_on_appointment();

-- ----------------------------------------------------------------------------
-- GAP 1c: human-takeover / assignment signals on properties itself.
-- Recreated (not altered in place — Postgres has no ALTER TRIGGER for a
-- column list) with the two extra columns added to the existing list.
-- ----------------------------------------------------------------------------
drop trigger if exists trg_properties_bump_decision_context_revision on public.properties;

create trigger trg_properties_bump_decision_context_revision
  before update of outreach_dispo, status, homeowner_contact_id, qualified_at, assigned_user_id, ai_responder_disabled
  on public.properties
  for each row execute function public.jev_bump_decision_context_revision();

-- ----------------------------------------------------------------------------
-- GAP 2: p_expected_revision on every propose/apply RPC.
--
-- `fn_apply_ai_disposition_with_review` is shared with the LEGACY
-- (Claude) apply path, which has no equivalent evaluation-time
-- revision concept in this bounded fix — its parameter is OPTIONAL
-- (default null = skip the check, preserving today's legacy behavior
-- exactly). The other four are Jev-only by construction (dnc Option B,
-- deferred below-threshold proposals, jev_lead_decisions propose/
-- auto-apply) — required.
-- ----------------------------------------------------------------------------

drop function if exists public.fn_apply_ai_disposition_with_review(uuid, uuid, uuid, text, text);
drop function if exists public.fn_propose_deferred_ai_disposition_review(uuid, uuid, uuid, text, text);
drop function if exists public.fn_propose_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer);
drop function if exists public.fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer);
drop function if exists public.fn_propose_ai_dnc_suppression_review(uuid, uuid, uuid, text);

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

create or replace function public.fn_propose_deferred_ai_disposition_review(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
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

revoke all on function public.fn_propose_deferred_ai_disposition_review(uuid, uuid, uuid, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_propose_deferred_ai_disposition_review(uuid, uuid, uuid, text, text, bigint) to service_role;

create or replace function public.fn_propose_jev_lead_decision(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_classification_run_id uuid,
  p_outcome text,
  p_native_confidence numeric,
  p_threshold_at_decision numeric,
  p_threshold_version integer,
  p_expected_revision bigint
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
  v_property record;
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

  select p.decision_context_revision into v_property
  from public.properties p
  where p.id = p_property_id and p.org_id = v_org_id
  for update;
  if not found then
    raise exception 'property does not match inbound SMS organization' using errcode = '23514';
  end if;
  if v_property.decision_context_revision is distinct from p_expected_revision then
    raise exception 'STALE_DECISION_CONTEXT' using errcode = '40001';
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

revoke all on function public.fn_propose_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_propose_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer, bigint) to service_role;

create or replace function public.fn_auto_apply_jev_lead_decision(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_classification_run_id uuid,
  p_outcome text,
  p_native_confidence numeric,
  p_threshold_at_decision numeric,
  p_threshold_version integer,
  p_expected_revision bigint
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
  v_property record;
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

  select p.decision_context_revision into v_property
  from public.properties p
  where p.id = p_property_id and p.org_id = v_org_id
  for update;
  if not found then
    raise exception 'property does not match inbound SMS organization' using errcode = '23514';
  end if;
  if v_property.decision_context_revision is distinct from p_expected_revision then
    -- Fail closed, distinctly from a generic write failure: the model's
    -- OWN input context is no longer current, so auto-applying it would
    -- silently apply a decision made against stale data. The caller
    -- treats this the same as any other apply failure — escalate to a
    -- human rather than either applying or silently dropping it.
    raise exception 'STALE_DECISION_CONTEXT' using errcode = '40001';
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

revoke all on function public.fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer, bigint) to service_role;

create or replace function public.fn_propose_ai_dnc_suppression_review(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
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

  if v_property.outreach_dispo = 'dnc' then
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

revoke all on function public.fn_propose_ai_dnc_suppression_review(uuid, uuid, uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_propose_ai_dnc_suppression_review(uuid, uuid, uuid, text, bigint) to service_role;

commit;
