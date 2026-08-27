-- Durable, conversation-scoped review workflow for dispositions applied by
-- Sandra's LLM responder. properties.outreach_dispo remains the applied
-- business/compliance outcome; this table answers the separate question:
-- "has a human reviewed the AI decision?"

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table public.ai_disposition_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  conversation_id uuid not null,
  source_inbound_message_id uuid not null references public.messages(id),
  disposition text not null,
  ai_reason text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  reviewed_by uuid,
  superseded_reason text,
  constraint ai_disposition_reviews_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id),
  constraint ai_disposition_reviews_disposition_check
    check (disposition in ('wrong_number', 'not_interested', 'opted_out', 'dnc')),
  constraint ai_disposition_reviews_status_check
    check (status in ('pending', 'confirmed', 'superseded')),
  constraint ai_disposition_reviews_resolution_check
    check (
      (status = 'pending'
        and resolved_at is null
        and reviewed_by is null
        and superseded_reason is null)
      or
      (status = 'confirmed'
        and resolved_at is not null
        and reviewed_by is not null
        and superseded_reason is null)
      or
      (status = 'superseded'
        and resolved_at is not null
        and reviewed_by is null
        and superseded_reason is not null)
    )
);

comment on table public.ai_disposition_reviews is
  'Authoritative per-conversation workflow state for LLM-applied dispositions awaiting human acknowledgement. The applied outcome remains properties.outreach_dispo.';
comment on column public.ai_disposition_reviews.source_inbound_message_id is
  'The exact inbound SMS that produced the AI decision; also the retry idempotency key.';

create unique index idx_ai_disposition_reviews_source_message
  on public.ai_disposition_reviews (source_inbound_message_id);

create unique index idx_ai_disposition_reviews_one_pending_conversation
  on public.ai_disposition_reviews (org_id, conversation_id)
  where status = 'pending';

create index idx_ai_disposition_reviews_pending_lookup
  on public.ai_disposition_reviews (org_id, conversation_id, created_at desc)
  where status = 'pending';

create index idx_ai_disposition_reviews_property
  on public.ai_disposition_reviews (property_id, created_at desc);

alter table public.ai_disposition_reviews enable row level security;

create policy ai_disposition_reviews_org_select
  on public.ai_disposition_reviews
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

revoke all on table public.ai_disposition_reviews
  from public, anon, authenticated, service_role;
grant select on table public.ai_disposition_reviews to authenticated;
grant select on table public.ai_disposition_reviews to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ai_disposition_reviews'
  ) then
    execute 'alter publication supabase_realtime add table public.ai_disposition_reviews';
  end if;
end $$;

-- Any outcome change outside the AI transaction makes an older pending
-- decision stale. The AI RPC resolves its previous pending row before it
-- updates the property and inserts the replacement, so this trigger also
-- catches every human, appointment, Jitter, CSV, and compliance writer
-- without requiring those paths to know about this queue.
create or replace function public.supersede_ai_disposition_reviews_on_outcome_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.outreach_dispo is not distinct from new.outreach_dispo then
    return new;
  end if;

  with resolved as (
    update public.ai_disposition_reviews review
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'property_outcome_changed'
    where review.property_id = new.id
      and review.org_id = new.org_id
      and review.status = 'pending'
    returning review.id, review.org_id, review.property_id,
      review.disposition, review.source_inbound_message_id
  )
  insert into public.lead_events (
    org_id, property_id, actor_type, event_type, payload,
    source_type, source_id
  )
  select
    resolved.org_id,
    resolved.property_id,
    'system',
    'ai_dispo_review_superseded',
    jsonb_build_object(
      'review_id', resolved.id,
      'proposed_disposition', resolved.disposition,
      'replacement_disposition', new.outreach_dispo,
      'reason', 'property_outcome_changed',
      'source_inbound_message_id', resolved.source_inbound_message_id
    ),
    'ai_disposition_reviews.superseded',
    resolved.id
  from resolved
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return new;
end;
$$;

revoke all on function public.supersede_ai_disposition_reviews_on_outcome_change()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_properties_supersede_ai_disposition_reviews
  on public.properties;
create trigger trg_properties_supersede_ai_disposition_reviews
  after update of outreach_dispo on public.properties
  for each row
  execute function public.supersede_ai_disposition_reviews_on_outcome_change();

-- Applies a model-selected disposition and creates the review record in the
-- same transaction. Only the trusted AI worker may call this RPC.
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

-- Confirmation is acknowledgement of an outcome that is already in force.
-- It never mutates properties or consent/compliance state.
create or replace function public.fn_confirm_ai_disposition_review(
  p_review_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_review public.ai_disposition_reviews%rowtype;
  v_outreach_dispo text;
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

  -- Match the AI writer's property -> review lock order to prevent a
  -- concurrent apply/confirm deadlock.
  select p.outreach_dispo
  into v_outreach_dispo
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

  if v_outreach_dispo is distinct from v_review.disposition then
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
        'replacement_disposition', v_outreach_dispo,
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

revoke all on function public.fn_confirm_ai_disposition_review(uuid)
  from public, anon, service_role;
grant execute on function public.fn_confirm_ai_disposition_review(uuid)
  to authenticated;

-- Duplicate-property merges must move review history before the loser row is
-- removed. This is the latest wrapper definition plus the new dependent.
create or replace function public.merge_duplicate_properties(
  keeper_id uuid,
  loser_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keeper_org_id uuid;
  v_loser_org_id uuid;
begin
  select p.org_id into v_keeper_org_id
  from public.properties p where p.id = keeper_id;
  select p.org_id into v_loser_org_id
  from public.properties p where p.id = loser_id;
  if v_keeper_org_id is null or v_loser_org_id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found'
      using errcode = 'P0002';
  end if;
  if v_keeper_org_id <> v_loser_org_id
     or not public.hugo_has_active_org_access(v_keeper_org_id) then
    raise exception 'merge_duplicate_properties: active access required'
      using errcode = '42501';
  end if;

  update public.lead_events
  set property_id = keeper_id
  where property_id = loser_id
    and org_id = v_keeper_org_id;

  update public.ai_disposition_reviews
  set property_id = keeper_id
  where property_id = loser_id
    and org_id = v_keeper_org_id;

  perform public.merge_duplicate_properties_hugo_unchecked(keeper_id, loser_id);
end;
$$;

revoke all on function public.merge_duplicate_properties(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.merge_duplicate_properties(uuid, uuid)
  to authenticated;

-- Keep integration-test cleanup explicit and aligned with the latest helper.
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

revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;

commit;
