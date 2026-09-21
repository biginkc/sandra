-- Needs-a-decision / Review-Jev backing store for new_lead and nurture —
-- the two outcomes with no existing review workflow. wrong_number /
-- not_interested / opted_out / dnc keep using ai_disposition_reviews
-- (20260827110000) + sms_classification_runs (20260920120000) unchanged;
-- their pending row already IS their Needs-a-decision case. This table
-- exists only because new_lead promotes properties.status (not
-- outreach_dispo) and nurture previously had no gate/review path at all.
--
-- Correction targets are deliberately restricted to {new_lead, nurture,
-- wrong_number, not_interested} — never dnc or opted_out. Both require a
-- TCPA phone-suppression side effect (consent_events / sms_opted_out)
-- that only the existing authenticated `setOutreachDispo` server action
-- performs correctly. A human who decides a new_lead/nurture case was
-- actually dnc/opted_out uses that existing control, not this RPC —
-- consistent with "no automatic DNC approval; no suppression removal
-- from a positive correction."

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table public.jev_lead_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  conversation_id uuid not null,
  source_inbound_message_id uuid not null references public.messages(id),
  classification_run_id uuid not null references public.sms_classification_runs(id),
  proposed_outcome text not null,
  native_confidence numeric(5,4),
  threshold_at_decision numeric(4,3),
  status text not null default 'pending',
  resolved_outcome text,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolution_reason text,
  superseded_reason text,
  created_at timestamptz not null default now(),
  constraint jev_lead_decisions_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id),
  constraint jev_lead_decisions_proposed_outcome_check
    check (proposed_outcome in ('new_lead', 'nurture')),
  constraint jev_lead_decisions_status_check
    check (status in ('pending', 'confirmed', 'corrected', 'superseded')),
  constraint jev_lead_decisions_resolved_outcome_check
    check (resolved_outcome is null or resolved_outcome in
      ('new_lead', 'nurture', 'wrong_number', 'not_interested')),
  constraint jev_lead_decisions_resolution_check check (
    (status = 'pending'
      and resolved_at is null and resolved_outcome is null
      and resolved_by is null and superseded_reason is null)
    or
    (status in ('confirmed', 'corrected')
      and resolved_at is not null and resolved_outcome is not null
      and superseded_reason is null)
    or
    (status = 'superseded'
      and resolved_at is not null and superseded_reason is not null
      and resolved_outcome is null)
  ),
  constraint jev_lead_decisions_source_message_unique
    unique (source_inbound_message_id)
);

comment on table public.jev_lead_decisions is
  'Needs-a-decision / Review-Jev backing store for new_lead and nurture only. wrong_number/not_interested/opted_out/dnc use ai_disposition_reviews instead — see file header.';
comment on column public.jev_lead_decisions.resolved_by is
  'null = system auto-apply (confirmed at threshold with no human involved). Non-null = a human confirmed or corrected it.';

create index idx_jev_lead_decisions_org_status
  on public.jev_lead_decisions (org_id, status, created_at desc);
create index idx_jev_lead_decisions_property
  on public.jev_lead_decisions (property_id, created_at desc);

alter table public.jev_lead_decisions enable row level security;

create policy jev_lead_decisions_org_select on public.jev_lead_decisions
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

-- No direct client write path — every mutation goes through the RPCs
-- below, each with its own authorization/staleness checks.
revoke all on table public.jev_lead_decisions
  from public, anon, authenticated, service_role;
grant select on table public.jev_lead_decisions to authenticated;
grant select on table public.jev_lead_decisions to service_role;

-- ----------------------------------------------------------------------------
-- fn_propose_jev_lead_decision — service-role only. Creates a pending row
-- for a below-threshold / human-gated new_lead or nurture decision.
-- Retry-safe via source_inbound_message_id's unique constraint (returns
-- the existing row rather than erroring). Supersedes any still-pending
-- row for the same property — only the latest classification should be
-- actionable, mirroring ai_disposition_reviews' own supersede pattern.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- fn_auto_apply_jev_lead_decision — service-role only. Records an
-- ALREADY-applied decision (the effect — qualifyProperty or the nurture
-- outreach_dispo write — already succeeded by the time this is called,
-- same "effect first, record second" ordering as
-- fn_accept_ai_disposition_review). resolved_by is left null: no human
-- was involved.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- fn_confirm_jev_lead_decision — authenticated. Any active org member may
-- confirm (operational triage, not an admin-gated setting). Applies the
-- proposed outcome in the same transaction, re-checking the property is
-- still in the exact state this decision assumed — fails STALE_STATE
-- rather than overwriting a newer human/inbound/system change.
-- ----------------------------------------------------------------------------
create or replace function public.fn_confirm_jev_lead_decision(
  p_decision_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision public.jev_lead_decisions%rowtype;
  v_property record;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  select * into v_decision
  from public.jev_lead_decisions
  where id = p_decision_id;
  if not found then
    raise exception 'DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_decision.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_decision
  from public.jev_lead_decisions
  where id = p_decision_id
  for update;

  if v_decision.status <> 'pending' then
    return jsonb_build_object(
      'status', v_decision.status, 'decisionId', v_decision.id,
      'resolvedOutcome', v_decision.resolved_outcome
    );
  end if;

  if v_decision.proposed_outcome = 'new_lead' then
    if v_property.is_dnc_locked then
      raise exception 'DNC_LOCKED' using errcode = '22023';
    end if;
    if v_property.status is distinct from 'prospect' then
      update public.jev_lead_decisions
      set status = 'superseded', resolved_at = now(),
          superseded_reason = 'property_outcome_changed'
      where id = v_decision.id;
      return jsonb_build_object('status', 'superseded', 'decisionId', v_decision.id);
    end if;
    update public.properties
    set status = 'new_lead',
        qualified_at = now(),
        qualified_by = v_actor::text,
        updated_at = now()
    where id = v_decision.property_id and org_id = v_decision.org_id;
  else
    -- nurture: must still be unset or already nurture (idempotent replay).
    if v_property.outreach_dispo is not null and v_property.outreach_dispo <> 'nurture' then
      update public.jev_lead_decisions
      set status = 'superseded', resolved_at = now(),
          superseded_reason = 'property_outcome_changed'
      where id = v_decision.id;
      return jsonb_build_object('status', 'superseded', 'decisionId', v_decision.id);
    end if;
    update public.properties
    set outreach_dispo = 'nurture',
        needs_human_attention = false,
        last_ai_escalation_reason = null,
        updated_at = now()
    where id = v_decision.property_id and org_id = v_decision.org_id;
  end if;

  update public.jev_lead_decisions
  set status = 'confirmed',
      resolved_outcome = v_decision.proposed_outcome,
      resolved_at = now(),
      resolved_by = v_actor
  where id = v_decision.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    v_decision.org_id, v_decision.property_id, 'user', v_actor,
    'jev_lead_decision_confirmed',
    jsonb_build_object('decision_id', v_decision.id, 'outcome', v_decision.proposed_outcome),
    'jev_lead_decisions.confirmed', v_decision.id
  )
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return jsonb_build_object(
    'status', 'confirmed', 'decisionId', v_decision.id,
    'resolvedOutcome', v_decision.proposed_outcome
  );
end;
$$;

revoke all on function public.fn_confirm_jev_lead_decision(uuid)
  from public, anon, service_role;
grant execute on function public.fn_confirm_jev_lead_decision(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_correct_jev_lead_decision — authenticated. Lets a human pick a
-- DIFFERENT outcome than proposed, whether the row is still pending or
-- already resolved. Restricted target set: {new_lead, nurture,
-- wrong_number, not_interested} — see file header for why dnc/opted_out
-- are excluded. Re-validates the property against what THIS decision
-- last actually resolved to (not just "pending"), so correcting an
-- already-confirmed row fails clearly if something newer changed the
-- property, rather than silently overwriting it.
-- ----------------------------------------------------------------------------
create or replace function public.fn_correct_jev_lead_decision(
  p_decision_id uuid,
  p_corrected_outcome text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision public.jev_lead_decisions%rowtype;
  v_property record;
  v_current_severity integer;
  v_next_severity integer;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_outcome not in ('new_lead', 'nurture', 'wrong_number', 'not_interested') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_decision
  from public.jev_lead_decisions
  where id = p_decision_id;
  if not found then
    raise exception 'DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_decision.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_decision.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_decision
  from public.jev_lead_decisions
  where id = p_decision_id
  for update;
  if v_decision.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Staleness pre-check: the property must still look exactly like what
  -- THIS decision assumed. A still-pending row assumed "untouched"
  -- (prospect status, no dispo yet). An already-resolved row assumed
  -- exactly what it last wrote — new_lead resolved to a status change,
  -- everything else to an outreach_dispo write. Any mismatch means
  -- something newer (human, inbound, another system writer) already
  -- changed this property; fail clearly rather than overwrite it.
  if v_decision.status = 'pending' then
    if v_property.status is distinct from 'prospect' or v_property.outreach_dispo is not null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_decision.resolved_outcome = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is distinct from v_decision.resolved_outcome then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  if p_corrected_outcome = 'new_lead' then
    if v_property.is_dnc_locked then
      raise exception 'DNC_LOCKED' using errcode = '22023';
    end if;
    if v_property.status is distinct from 'prospect' and v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
    if v_property.status is distinct from 'new_lead' then
      update public.properties
      set status = 'new_lead', qualified_at = now(), qualified_by = v_actor::text,
          updated_at = now()
      where id = v_decision.property_id and org_id = v_decision.org_id;
    end if;
  else
    -- Terminal-priority guard, same ordering fn_apply_ai_disposition_with_review
    -- uses for its four outreach_dispo outcomes (20260827110000) — a
    -- correction must not downgrade a more specific existing disposition
    -- (e.g. correcting a "needs a decision: nurture" item to
    -- not_interested must not clobber a dnc/opted_out that landed via a
    -- separate later message in the meantime).
    if v_property.outreach_dispo is distinct from p_corrected_outcome then
      if v_property.outreach_dispo in ('opted_out', 'dnc', 'bad_number', 'callback_requested', 'booked_appointment') then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
      v_current_severity := case v_property.outreach_dispo
        when 'not_interested' then 1
        when 'wrong_number' then 2
        when 'nurture' then 0
        else 0
      end;
      v_next_severity := case p_corrected_outcome
        when 'nurture' then 0
        when 'not_interested' then 1
        when 'wrong_number' then 2
      end;
      if v_next_severity < v_current_severity then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
      update public.properties
      set outreach_dispo = p_corrected_outcome,
          needs_human_attention = false,
          last_ai_escalation_reason = null,
          updated_at = now()
      where id = v_decision.property_id and org_id = v_decision.org_id;
    end if;
  end if;

  update public.jev_lead_decisions
  set status = 'corrected',
      resolved_outcome = p_corrected_outcome,
      resolved_at = now(),
      resolved_by = v_actor,
      resolution_reason = nullif(btrim(p_reason), '')
  where id = v_decision.id;

  -- No source_type/source_id here (unlike confirm/propose above):
  -- lead_events enforces a unique (source_type, source_id) identity, but
  -- unlike "confirmed"/"superseded" — which happen at most once per
  -- row — a correction is explicitly allowed to happen more than once on
  -- the same decision (e.g. wrong_number -> nurture, then later
  -- nurture -> new_lead). Reusing decision.id as the dedup key would
  -- make every correction after the first fail on the unique index.
  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload
  ) values (
    v_decision.org_id, v_decision.property_id, 'user', v_actor,
    'jev_lead_decision_corrected',
    jsonb_build_object(
      'decision_id', v_decision.id,
      'proposed_outcome', v_decision.proposed_outcome,
      'previous_resolved_outcome', v_decision.resolved_outcome,
      'corrected_outcome', p_corrected_outcome,
      'reason', p_reason
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'decisionId', v_decision.id,
    'resolvedOutcome', p_corrected_outcome
  );
end;
$$;

revoke all on function public.fn_correct_jev_lead_decision(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_correct_jev_lead_decision(uuid, text, text) to authenticated;

-- reset_tenant_tables() (last redefined in 20260920225859_jev_outcome_thresholds.sql)
-- must truncate jev_lead_decisions too — it FKs to organizations, which
-- is not itself truncated, so TRUNCATE ... CASCADE would not reach it.
create or replace function public.reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  create temp table _memberships_snapshot on commit drop as
    select * from public.memberships;

  truncate table
    public.jev_lead_decisions,
    public.jev_outcome_threshold_history,
    public.jev_outcome_thresholds,
    public.user_integration_prefs,
    public.user_oauth_tokens,
    public.call_recordings,
    public.call_transcripts,
    public.call_activities,
    public.dialer_batch_items,
    public.dialer_batches,
    public.dashboard_snapshots,
    public.metric_snapshots,
    public.memberships,
    public.task_reminder_deliveries,
    public.task_calendar_mutations,
    public.tasks,
    public.job_items,
    public.ai_response_claims,
    public.sms_inbound_deliveries,
    public.sms_inbound_intents,
    public.campaign_recipients,
    public.campaign_delivery_settings,
    public.campaigns,
    public.provider_sender_numbers,
    public.provider_campaigns,
    public.ai_disposition_reviews,
    public.message_threads,
    public.messages,
    public.consent_events,
    public.sms_phone_suppressions,
    public.property_merges,
    public.jobs,
    public.csv_imports,
    public.webhook_events,
    public.webhook_consumers,
    public.notifications,
    public.lead_events,
    public.lead_notes,
    public.sequence_step_runs,
    public.sequence_enrollments,
    public.sequence_steps,
    public.sequences,
    public.ai_responder_configs,
    public.property_lists,
    public.property_tags,
    public.tags,
    public.test_sms_log,
    public.closer_practice_outcomes,
    public.institute_course_outcomes,
    public.properties,
    public.homeowner_details,
    public.agent_details,
    public.contacts,
    public.cass_cache,
    public.skip_trace_cache
  restart identity cascade;

  insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, version, updated_by)
  select o.id, v.outcome, v.min_confidence, 1, null
  from public.organizations o
  cross join (values
    ('new_lead', 0.90),
    ('wrong_number', 0.90),
    ('not_interested', 0.95),
    ('nurture', 0.95),
    ('opted_out', 0.95)
  ) as v(outcome, min_confidence)
  on conflict (org_id, outcome) do nothing;

  delete from public.lists where coalesce(system_managed, false) = false;

  delete from public.sms_templates
  where coalesce(system_managed, false) = false
    and deleted_at is null;

  delete from public.saved_filters
  where coalesce(is_base, false) = false;

  insert into public.memberships
  select * from _memberships_snapshot
  where role = 'owner'
    and access_status = 'active'
    and deletion_prepared_at is null
    and access_expires_at is null
  order by org_id, user_id, id
  on conflict (user_id, org_id) do nothing;

  insert into public.memberships
  select * from _memberships_snapshot
  where role <> 'owner'
     or access_status <> 'active'
     or deletion_prepared_at is not null
     or access_expires_at is not null
  order by org_id, user_id, id
  on conflict (user_id, org_id) do nothing;
end;
$$;

commit;
