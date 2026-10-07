-- Root review of 57236716 (jev-root-round16-promotion-revision.md): two
-- release blockers in fn_promote_classifier_event_to_decision, left
-- unfixed by 20260921064657 (already recorded locally — not rewritten,
-- this is a follow-up).
--
-- 1) The property was locked but only p.id was selected, and the INSERT
--    never set decision_context_revision — the new pending row relied
--    entirely on trg_jev_lead_decisions_capture_revision's own separate
--    (unlocked) re-read to backfill it. Fixed: capture
--    decision_context_revision from the SAME locked select and write it
--    into the INSERT explicitly, so the promoted row's revision is
--    never anything but the exact value the lock observed.
--
-- 2) The "one pending per property" repair only selected/superseded a
--    SINGLE v_pending row via `select ... into v_pending`. If more than
--    one pending row already existed for a property (the exact
--    pre-existing-bug scenario this repair exists for), every row after
--    the first survived — the invariant was not actually restored.
--    Fixed: a single set-based UPDATE supersedes EVERY pending row for
--    the org/property before the new row is inserted, and the
--    superseded ids are captured via RETURNING into an array (not an
--    arbitrary single-row SELECT INTO) for a deterministic audit
--    payload. Same-source idempotency is unaffected: the existing
--    already_promoted check above (matched on this exact
--    source_inbound_message_id) already returns before this point for
--    that case, so every row this step supersedes necessarily belongs
--    to a DIFFERENT inbound message.

create or replace function public.fn_promote_classifier_event_to_decision(
  p_classification_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_run public.sms_classification_runs%rowtype;
  v_property record;
  v_superseded_ids uuid[];
  v_existing public.jev_lead_decisions%rowtype;
  v_decision public.jev_lead_decisions%rowtype;
  v_placeholder_outcome text;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  select * into v_run
  from public.sms_classification_runs
  where id = p_classification_run_id
  for share;
  if not found then
    raise exception 'CLASSIFICATION_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_run.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_run.provider <> 'jev' then
    raise exception 'NOT_A_CLASSIFIER_EVENT' using errcode = '22023';
  end if;
  if v_run.fallback_reason is null
    and (v_run.resolved_outcome is null or v_run.resolved_outcome not in ('unclear', 'bad_number'))
  then
    raise exception 'NOT_A_CLASSIFIER_EVENT' using errcode = '22023';
  end if;

  v_placeholder_outcome := coalesce(v_run.resolved_outcome, 'unclear');

  -- Lock the property BEFORE touching jev_lead_decisions — same order
  -- confirm/correct/apply use, so a promotion can never deadlock against
  -- them. Capture decision_context_revision from THIS locked read —
  -- finding 1: the promoted row's revision must be exactly what the
  -- lock observed, not a default or a separately re-read value.
  select p.id, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_run.property_id and p.org_id = v_run.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Race-safe via jev_lead_decisions' existing unique constraint on
  -- source_inbound_message_id: a concurrent double-promotion of the same
  -- inbound conflicts and this branch re-reads the winner instead.
  select * into v_existing
  from public.jev_lead_decisions
  where source_inbound_message_id = v_run.source_inbound_message_id;
  if v_existing.id is not null then
    return jsonb_build_object('status', 'already_promoted', 'decisionId', v_existing.id);
  end if;

  -- One pending decision per property: finding 2 — supersede EVERY
  -- pending row for this property in one set-based UPDATE, not just the
  -- first one found. Every row touched here belongs to a DIFFERENT
  -- inbound message than this one (see already_promoted check above).
  with superseded as (
    update public.jev_lead_decisions
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'new_classifier_event_promoted'
    where org_id = v_run.org_id
      and property_id = v_run.property_id
      and status = 'pending'
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_superseded_ids from superseded;

  insert into public.jev_lead_decisions (
    org_id, property_id, conversation_id, source_inbound_message_id,
    classification_run_id, proposed_outcome, status, decision_context_revision
  ) values (
    v_run.org_id, v_run.property_id, v_run.conversation_id, v_run.source_inbound_message_id,
    p_classification_run_id, v_placeholder_outcome, 'pending', v_property.decision_context_revision
  )
  on conflict (source_inbound_message_id) do nothing
  returning * into v_decision;

  if v_decision.id is null then
    select * into v_existing
    from public.jev_lead_decisions
    where source_inbound_message_id = v_run.source_inbound_message_id;
    return jsonb_build_object('status', 'already_promoted', 'decisionId', v_existing.id);
  end if;

  update public.properties
  set needs_human_attention = true, updated_at = now()
  where id = v_run.property_id and org_id = v_run.org_id;

  insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload)
  values (
    v_run.org_id, v_run.property_id, 'user', v_actor, 'jev_classifier_event_promoted',
    jsonb_build_object(
      'classification_run_id', p_classification_run_id,
      'decision_id', v_decision.id,
      'placeholder_outcome', v_placeholder_outcome,
      'fallback_reason', v_run.fallback_reason,
      'superseded_pending_decision_ids', to_jsonb(v_superseded_ids)
    )
  );

  return jsonb_build_object('status', 'promoted', 'decisionId', v_decision.id);
end;
$$;
