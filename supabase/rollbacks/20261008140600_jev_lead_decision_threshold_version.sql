-- Rollback for 20261008140600_jev_lead_decision_threshold_version.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration dropped: put the prior version back first (triggers below may point at them).
-- fn_propose_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric): re-create (dropped by this migration) from 20261008140100_jev_lead_decisions.sql
create or replace function public.fn_propose_jev_lead_decision(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_classification_run_id uuid,
  p_outcome text,
  p_native_confidence numeric,
  p_threshold_at_decision numeric
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
    threshold_at_decision
  ) values (
    v_org_id, p_property_id, p_conversation_id, p_source_inbound_message_id,
    p_classification_run_id, p_outcome, p_native_confidence,
    p_threshold_at_decision
  )
  returning * into v_row;

  return jsonb_build_object('status', 'proposed', 'decisionId', v_row.id);
end;
$$;
revoke all on function public.fn_propose_jev_lead_decision(
  uuid, uuid, uuid, uuid, text, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.fn_propose_jev_lead_decision(
  uuid, uuid, uuid, uuid, text, numeric, numeric
) to service_role;
-- fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric): re-create (dropped by this migration) from 20261008140100_jev_lead_decisions.sql
create or replace function public.fn_auto_apply_jev_lead_decision(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_classification_run_id uuid,
  p_outcome text,
  p_native_confidence numeric,
  p_threshold_at_decision numeric
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
    threshold_at_decision, status, resolved_outcome, resolved_at
  ) values (
    v_org_id, p_property_id, p_conversation_id, p_source_inbound_message_id,
    p_classification_run_id, p_outcome, p_native_confidence,
    p_threshold_at_decision, 'confirmed', p_outcome, now()
  )
  returning * into v_row;

  return jsonb_build_object('status', 'confirmed', 'decisionId', v_row.id);
end;
$$;
revoke all on function public.fn_auto_apply_jev_lead_decision(
  uuid, uuid, uuid, uuid, text, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.fn_auto_apply_jev_lead_decision(
  uuid, uuid, uuid, uuid, text, numeric, numeric
) to service_role;

-- Functions this migration created (no prior version): drop.
drop function if exists public.fn_propose_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer);
drop function if exists public.fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer);

-- Tables / columns / constraints
alter table if exists public.jev_lead_decisions
  drop column if exists threshold_version;

commit;
