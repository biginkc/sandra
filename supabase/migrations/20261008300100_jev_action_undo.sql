-- 20261008300100_jev_action_undo.sql
-- Jarrad (2026-10-07, verbatim): "Jev shouldn't be making any actions that are
-- irreversible."
--
-- When Jev auto-applies wrong_number / not_interested / nurture, the app records
-- what it changed (prior outreach_dispo, prior follow_up_at, and the sequence
-- enrollments Jev's own action paused) in jev_action_undo. fn_undo_jev_action
-- restores the disposition and follow_up_at in one transaction; the caller then
-- resumes the returned enrollment ids through resume_sequence_enrollment.
--
-- Written only by service_role (dispatch). Read by active org members. Undo is
-- refused when a human changed the disposition since (STATE_CHANGED).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 'undone' is a valid resolution for a nurture decision a person reversed. Every
-- value allowed since 20261008140300 (incl. opted_out/dnc for human corrections)
-- is kept; only 'undone' is appended.
alter table public.jev_lead_decisions
  drop constraint if exists jev_lead_decisions_resolved_outcome_check;
alter table public.jev_lead_decisions
  add constraint jev_lead_decisions_resolved_outcome_check
  check (resolved_outcome is null or resolved_outcome in
    ('new_lead', 'nurture', 'wrong_number', 'not_interested', 'opted_out', 'dnc', 'undone'));

create table if not exists public.jev_action_undo (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  source_inbound_message_id uuid not null references public.messages(id) on delete cascade,
  classification_run_id uuid,
  action text not null check (action in ('wrong_number', 'not_interested', 'nurture')),
  applied_dispo text not null,
  prior_outreach_dispo text,
  prior_follow_up_at timestamptz,
  applied_follow_up_at timestamptz,
  recorded_revision bigint,
  paused_enrollment_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  -- undone_by may go null later (user deleted, on delete set null), but an
  -- actor can never be recorded without a timestamp.
  constraint jev_action_undo_undone_pair
    check (undone_by is null or undone_at is not null)
);
comment on table public.jev_action_undo is
  'Prior state captured when Jev auto-applied a reversible action, so a human can undo it from the Messages v2 live feed.';

create unique index if not exists idx_jev_action_undo_source_message
  on public.jev_action_undo (source_inbound_message_id);
create index if not exists idx_jev_action_undo_property
  on public.jev_action_undo (property_id, created_at desc);

alter table public.jev_action_undo enable row level security;
revoke all on public.jev_action_undo from public, anon, authenticated;
grant select on public.jev_action_undo to authenticated;
grant select, insert, update on public.jev_action_undo to service_role;

drop policy if exists jev_action_undo_org_select on public.jev_action_undo;
create policy jev_action_undo_org_select on public.jev_action_undo
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );

create or replace function public.fn_undo_jev_action(p_undo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_undo public.jev_action_undo%rowtype;
  v_current text;
  v_current_follow timestamptz;
  v_decision_id uuid;
  v_review_id uuid;
  v_revision bigint;
  v_contact_id uuid;
  v_phones text[];
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_undo_id is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  select * into v_undo from public.jev_action_undo where id = p_undo_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_undo.org_id)
     or v_undo.org_id not in (select public.pipeline_runs_readable_org_ids()) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_undo.undone_at is not null then
    return jsonb_build_object('status', 'already_undone', 'enrollmentIds', '[]'::jsonb);
  end if;

  select p.outreach_dispo, p.follow_up_at, p.decision_context_revision, p.homeowner_contact_id
  into v_current, v_current_follow, v_revision, v_contact_id
  from public.properties p
  where p.id = v_undo.property_id and p.org_id = v_undo.org_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_current is distinct from v_undo.applied_dispo
     or v_current_follow is distinct from v_undo.applied_follow_up_at then
    -- A person (or a later decision) changed the disposition or the follow-up
    -- date since: never overwrite that.
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;

  -- Something decision-relevant happened since (newer inbound text, status or
  -- disposition write, booked appointment): a person must look at it again.
  if v_undo.recorded_revision is not null and v_revision is distinct from v_undo.recorded_revision then
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;

  -- A person already confirmed Jev's decision: that is a human decision now.
  if exists (
    select 1 from public.ai_disposition_reviews r
    where r.source_inbound_message_id = v_undo.source_inbound_message_id
      and r.org_id = v_undo.org_id and r.status = 'confirmed' and r.reviewed_by is not null
  ) or exists (
    select 1 from public.jev_lead_decisions d
    where d.source_inbound_message_id = v_undo.source_inbound_message_id
      and d.org_id = v_undo.org_id and d.status = 'confirmed' and d.resolved_by is not null
  ) then
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;

  -- Never undo into a state where the number is opted out / suppressed.
  if v_contact_id is not null and exists (
    select 1 from public.contacts c
    where c.id = v_contact_id and (c.sms_opted_out or c.do_not_contact)
  ) then
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;
  select array_remove(array[
           (select m.from_address from public.messages m where m.id = v_undo.source_inbound_message_id),
           c.phone_1, c.phone_2, c.phone_3], null)
  into v_phones
  from (select 1) one
  left join public.contacts c on c.id = v_contact_id;
  if coalesce(cardinality(v_phones), 0) > 0 and exists (
    select 1 from public.sms_phone_suppressions sp
    where sp.org_id = v_undo.org_id and sp.channel = 'sms' and sp.phone_e164 = any(v_phones)
  ) then
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;

  update public.properties
  set outreach_dispo = v_undo.prior_outreach_dispo,
      follow_up_at = v_undo.prior_follow_up_at,
      updated_at = now()
  where id = v_undo.property_id and org_id = v_undo.org_id;

  -- Make the scorecard count the undo as a disagreement with Jev.
  if v_undo.action = 'nurture' then
    select d.id into v_decision_id
    from public.jev_lead_decisions d
    where d.source_inbound_message_id = v_undo.source_inbound_message_id
      and d.org_id = v_undo.org_id and d.status = 'confirmed'
    for update;
    if v_decision_id is not null then
      update public.jev_lead_decisions
      set status = 'corrected',
          resolved_outcome = 'undone',
          resolved_at = now(),
          resolved_by = v_actor,
          resolution_reason = 'undone from Messages v2'
      where id = v_decision_id;
      insert into public.lead_events (
        org_id, property_id, actor_type, actor_id, event_type, payload
      ) values (
        v_undo.org_id, v_undo.property_id, 'user', v_actor,
        'jev_lead_decision_corrected',
        jsonb_build_object(
          'decision_id', v_decision_id,
          'proposed_outcome', 'nurture',
          'previous_resolved_outcome', 'nurture',
          'corrected_outcome', 'undone',
          'reason', 'undone from Messages v2'
        )
      );
    end if;
  else
    select r.id into v_review_id
    from public.ai_disposition_reviews r
    where r.source_inbound_message_id = v_undo.source_inbound_message_id
      and r.org_id = v_undo.org_id;
    if v_review_id is not null then
      insert into public.lead_events (
        org_id, property_id, actor_type, actor_id, event_type, payload
      ) values (
        v_undo.org_id, v_undo.property_id, 'user', v_actor,
        'ai_disposition_review_corrected',
        jsonb_build_object(
          'review_id', v_review_id,
          'previous_disposition', v_undo.applied_dispo,
          'corrected_disposition', 'undone',
          'reason', 'undone from Messages v2'
        )
      );
    end if;
  end if;

  update public.jev_action_undo
  set undone_at = now(), undone_by = v_actor
  where id = v_undo.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    v_undo.org_id, v_undo.property_id, 'user', v_actor, 'jev_action_undone',
    jsonb_build_object(
      'action', v_undo.action,
      'applied_dispo', v_undo.applied_dispo,
      'restored_dispo', v_undo.prior_outreach_dispo,
      'restored_follow_up_at', v_undo.prior_follow_up_at,
      'source_inbound_message_id', v_undo.source_inbound_message_id
    ),
    'jev_action_undo', v_undo.id
  )
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return jsonb_build_object(
    'status', 'undone',
    'propertyId', v_undo.property_id,
    'enrollmentIds', to_jsonb(v_undo.paused_enrollment_ids)
  );
end;
$$;

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
  v_run record;
  v_existing public.jev_lead_decisions%rowtype;
  v_pending public.jev_lead_decisions%rowtype;
  v_row public.jev_lead_decisions%rowtype;
  v_property record;
  v_effect_status text;
  v_updated_id uuid;
  v_after record;
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

  -- Root review of 999feefb, finding 3: the audit trail's own integrity
  -- guard — verify the classification run this decision cites is REALLY
  -- the one that produced it, before any effect or insert happens.
  select cr.org_id, cr.property_id, cr.conversation_id, cr.source_inbound_message_id,
         cr.provider, cr.resolved_outcome
  into v_run
  from public.sms_classification_runs cr
  where cr.id = p_classification_run_id;
  if not found
    or v_run.org_id is distinct from v_org_id
    or v_run.property_id is distinct from p_property_id
    or v_run.conversation_id is distinct from p_conversation_id
    or v_run.source_inbound_message_id is distinct from p_source_inbound_message_id
    or v_run.provider is distinct from 'jev'
    or v_run.resolved_outcome is distinct from p_outcome
  then
    raise exception 'classification_run_id does not match this decision (org/property/conversation/source message/provider/outcome)'
      using errcode = '23514';
  end if;

  select * into v_existing
  from public.jev_lead_decisions d
  where d.source_inbound_message_id = p_source_inbound_message_id;
  if found then
    return jsonb_build_object('status', 'replayed', 'decisionId', v_existing.id);
  end if;

  -- Lock the property row and read everything the effect below needs, in
  -- ONE select — the SAME row version the revision check below judges.
  select
    p.decision_context_revision, p.outreach_dispo, p.status,
    p.is_dnc_locked, p.is_training, p.follow_up_at
  into v_property
  from public.properties p
  where p.id = p_property_id and p.org_id = v_org_id
  for update;
  if not found then
    raise exception 'property does not match inbound SMS organization' using errcode = '23514';
  end if;
  if v_property.decision_context_revision is distinct from p_expected_revision then
    -- Fail closed, distinctly from a generic write failure: the model's
    -- OWN input context is no longer current, so auto-applying it would
    -- silently apply a decision made against stale data. Checked BEFORE
    -- any write this function makes — never rebased or bumped by this
    -- call itself.
    raise exception 'STALE_DECISION_CONTEXT' using errcode = '40001';
  end if;

  -- Root review of 3e4ee3b1, finding 2: training-target block now covers
  -- EVERY automatic Jev customer-state effect, not just nurture — checked
  -- once, before the outcome branches below, so a training prospect can
  -- never be auto-promoted to new_lead either. No effect, no audit row.
  if v_property.is_training then
    raise exception 'Customer actions are unavailable for an internal training lead.' using errcode = '22023';
  end if;

  -- ------------------------------------------------------------------
  -- Effect: applied atomically with the revision check above (same
  -- transaction, same locked row) and BEFORE the audit insert below, so
  -- a decision row only ever exists for an outcome that was actually
  -- (or was already) applied.
  -- ------------------------------------------------------------------
  if p_outcome = 'nurture' then
    if v_property.outreach_dispo is not null and v_property.outreach_dispo <> 'nurture' then
      -- Something more specific already set (possibly by a human while
      -- Jev was classifying) — nurture must never downgrade it. Same
      -- "already_terminal" treatment setOutreachDispoNurture already
      -- had; no decision row recorded for this case (matches the TS
      -- caller's existing silent-skip branch).
      return jsonb_build_object('status', 'already_terminal');
    end if;
    if v_property.outreach_dispo is distinct from 'nurture' then
      update public.properties
      set outreach_dispo = 'nurture', follow_up_at = null, updated_at = now()
      where id = p_property_id and org_id = v_org_id
        and outreach_dispo is not distinct from v_property.outreach_dispo
      returning id, decision_context_revision, follow_up_at into v_after;
      v_updated_id := v_after.id;
      if v_updated_id is null then
        -- Defense in depth: the row is already locked FOR UPDATE above,
        -- so this branch should be unreachable, but never silently
        -- apply on an unexpected miss.
        return jsonb_build_object('status', 'already_terminal');
      end if;
      v_effect_status := 'applied';
      -- Record the prior state for Undo in THIS transaction, under the property
      -- row lock: a human edit can never be captured as "what Jev applied".
      insert into public.jev_action_undo (
        org_id, property_id, source_inbound_message_id, classification_run_id,
        action, applied_dispo, prior_outreach_dispo, prior_follow_up_at,
        applied_follow_up_at, recorded_revision
      ) values (
        v_org_id, p_property_id, p_source_inbound_message_id, p_classification_run_id,
        'nurture', 'nurture', v_property.outreach_dispo, v_property.follow_up_at,
        v_after.follow_up_at, v_after.decision_context_revision
      )
      on conflict (source_inbound_message_id) do nothing;
    else
      -- Already exactly 'nurture' — idempotent no-op, but (matching the
      -- prior TS behavior) still proceeds to record the decision.
      v_effect_status := 'already_nurture';
    end if;
  else -- new_lead
    if v_property.is_dnc_locked then
      return jsonb_build_object('status', 'dnc_locked');
    end if;
    if v_property.status is distinct from 'prospect' then
      -- Already promoted via another path — matches qualifyProperty's
      -- "already_qualified": still records the decision (Jev's call was
      -- correct, even though something else got there first).
      v_effect_status := 'already_qualified';
    else
      update public.properties
      set status = 'new_lead', qualified_at = now(), qualified_by = 'system:jev_auto_promote', updated_at = now()
      where id = p_property_id and org_id = v_org_id
        and status = 'prospect' and is_dnc_locked = false
      returning id into v_updated_id;
      if v_updated_id is null then
        -- Defense in depth: row already locked FOR UPDATE above, so this
        -- should be unreachable.
        return jsonb_build_object('status', 'not_found');
      end if;
      v_effect_status := 'applied';
    end if;
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

  return jsonb_build_object('status', v_effect_status, 'decisionId', v_row.id);
end;
$$;

revoke all on function public.fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric, integer, bigint) to service_role;

revoke all on function public.fn_undo_jev_action(uuid) from public, anon, service_role;
grant execute on function public.fn_undo_jev_action(uuid) to authenticated;

commit;
