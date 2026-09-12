-- My Leads workflow commands: readiness, offers, contract, decline, handoff
-- and explicit contract archival. Every operation is one transaction and
-- records a replayable acquisition_commands result before any reassignment
-- trigger can observe a handoff.

begin;

-- Needs Sequence is an existing shared disposition axis. Preserve every
-- deployed value while widening the check used by atomic decline/handoff.
alter table public.properties drop constraint if exists properties_outreach_dispo_check;
alter table public.properties add constraint properties_outreach_dispo_check
  check (outreach_dispo is null or outreach_dispo in (
    'wrong_number', 'bad_number', 'not_interested', 'opted_out', 'dnc',
    'nurture', 'callback_requested', 'needs_sequence', 'booked_appointment'
  ));

create or replace function public.my_leads_workflow_require_actor(p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or p_org_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.memberships m
    where m.org_id = p_org_id
      and m.user_id = v_actor
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

create or replace function public.my_leads_workflow_replay(
  p_org_id uuid,
  p_operation text,
  p_idempotency_key uuid,
  p_actor uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.acquisition_commands%rowtype;
begin
  select * into v_existing
  from public.acquisition_commands c
  where c.org_id = p_org_id
    and c.operation = p_operation
    and c.idempotency_key = p_idempotency_key
  for update;
  if not found then return null; end if;
  if v_existing.actor_kind <> 'user'
     or v_existing.actor_user_id is distinct from p_actor
     or v_existing.request_hash is distinct from p_request_hash then
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001';
  end if;
  return jsonb_set(v_existing.result, '{duplicate}', 'true'::jsonb, true);
end;
$$;

create or replace function public.my_leads_workflow_assert_motivation(
  p_kind text,
  p_text text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind = 'no_motivation' then
    if p_text is not null and btrim(p_text) <> '' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    return;
  end if;
  if p_kind = 'specified' and p_text is not null and btrim(p_text) <> '' then
    return;
  end if;
  raise exception 'INVALID_INPUT' using errcode = '22023';
end;
$$;

create or replace function public.my_leads_workflow_append_event(
  p_org_id uuid,
  p_property_id uuid,
  p_actor uuid,
  p_command_id uuid,
  p_operation text,
  p_payload jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type,
    payload, source_type, source_id
  ) values (
    p_org_id, p_property_id, 'user', p_actor, 'my_leads_workflow',
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('operation', p_operation),
    'acquisition_command', p_command_id
  )
  on conflict do nothing;
$$;

revoke all on function public.my_leads_workflow_require_actor(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.my_leads_workflow_replay(uuid, text, uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.my_leads_workflow_assert_motivation(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.my_leads_workflow_append_event(uuid, uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.fn_ready_acquisition_offer(
  p_org_id uuid,
  p_property_id uuid,
  p_expected_episode_id uuid,
  p_expected_queue_version bigint,
  p_expected_shared_status text,
  p_idempotency_key uuid,
  p_motivation_kind text,
  p_motivation_text text,
  p_temperature text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_queue_exists boolean;
  v_episode_exists boolean;
  v_role text;
  v_stage text;
  v_version bigint;
begin
  if p_property_id is null or p_expected_episode_id is null
     or p_expected_queue_version is null or p_expected_queue_version < 0
     or p_expected_shared_status is null or p_idempotency_key is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform public.my_leads_workflow_assert_motivation(p_motivation_kind, p_motivation_text);
  if p_temperature is not null and p_temperature not in ('hot', 'warm', 'cold') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  v_hash := public.my_leads_command_hash(
    'ready_acquisition_offer', p_org_id, v_actor,
    jsonb_build_object(
      'propertyId', p_property_id,
      'expectedEpisodeId', p_expected_episode_id,
      'expectedQueueVersion', p_expected_queue_version,
      'expectedSharedStatus', p_expected_shared_status,
      'motivationKind', p_motivation_kind,
      'motivationText', p_motivation_text,
      'temperature', p_temperature
    )
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'ready_acquisition_offer', p_idempotency_key), 0
  ));
  v_replay := public.my_leads_workflow_replay(
    p_org_id, 'ready_acquisition_offer', p_idempotency_key, v_actor, v_hash
  );
  if v_replay is not null then return v_replay; end if;
  if not exists (
    select 1 from public.acquisition_org_settings s
    where s.org_id = p_org_id and s.my_leads_enabled
  ) then
    raise exception 'FEATURE_DISABLED' using errcode = '42501';
  end if;

  select * into v_property
  from public.properties p
  where p.id = p_property_id and p.org_id = p_org_id
  for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_property.is_dnc_locked or v_property.outreach_dispo = 'dnc' then
    raise exception 'DNC_LOCKED' using errcode = '42501';
  end if;
  if v_property.status is distinct from p_expected_shared_status then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;
  select m.role into v_role
  from public.memberships m
  where m.org_id = p_org_id and m.user_id = v_actor
    and m.access_status = 'active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_role <> 'owner' and v_property.assigned_user_id is distinct from v_actor then
    raise exception 'STALE_ASSIGNMENT' using errcode = '40001';
  end if;
  if v_property.status in ('offer_sent', 'offer_declined', 'under_contract', 'closed', 'dead') then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  select * into v_queue
  from public.acquisition_queue_states q
  where q.org_id = p_org_id and q.property_id = p_property_id
  for update;
  v_queue_exists := found;
  v_version := coalesce(v_queue.version, 0);
  if v_version <> p_expected_queue_version then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;
  v_stage := coalesce(v_queue.stage, 'not_contacted');
  if v_stage in ('offer_sent', 'under_contract') or v_queue.archived_at is not null then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;
  select * into v_episode
  from public.acquisition_assignment_episodes e
  where e.org_id = p_org_id and e.property_id = p_property_id and e.ended_at is null
  for update;
  v_episode_exists := found;
  if not v_episode_exists or v_episode.id is distinct from p_expected_episode_id then
    raise exception 'STALE_ASSIGNMENT' using errcode = '40001';
  end if;

  if v_queue_exists then
    update public.acquisition_queue_states q
    set stage = 'needs_offer', stage_entered_at = statement_timestamp(),
        motivation_recorded = true, motivation_kind = p_motivation_kind,
        motivation_text = case when p_motivation_kind = 'specified' then btrim(p_motivation_text) end,
        motivation_recorded_at = statement_timestamp(), motivation_recorded_by = v_actor,
        version = q.version + 1, updated_at = statement_timestamp()
    where q.org_id = p_org_id and q.property_id = p_property_id;
  else
    insert into public.acquisition_queue_states (
      org_id, property_id, stage, stage_entered_at, motivation_recorded,
      motivation_kind, motivation_text, motivation_recorded_at, motivation_recorded_by, version
    ) values (
      p_org_id, p_property_id, 'needs_offer', statement_timestamp(), true,
      p_motivation_kind, case when p_motivation_kind = 'specified' then btrim(p_motivation_text) end,
      statement_timestamp(), v_actor, 1
    );
  end if;
  if p_temperature is not null then
    update public.properties set motivation_level = p_temperature where id = p_property_id and org_id = p_org_id;
  end if;
  update public.properties
  set status = 'interested', updated_at = statement_timestamp()
  where id = p_property_id and org_id = p_org_id
    and status in ('prospect', 'new_lead', 'contacted');
  v_result := jsonb_build_object(
    'ok', true, 'duplicate', false, 'propertyId', p_property_id,
    'queueVersion', v_version + 1, 'stage', 'needs_offer', 'archived', false,
    'assignmentEpisodeId', v_episode.id
  );
  insert into public.acquisition_commands (
    id, org_id, actor_user_id, actor_kind, operation, idempotency_key, request_hash, result
  ) values (
    v_command_id, p_org_id, v_actor, 'user', 'ready_acquisition_offer',
    p_idempotency_key, v_hash, v_result
  );
  perform public.my_leads_workflow_append_event(
    p_org_id, p_property_id, v_actor, v_command_id, 'ready_acquisition_offer',
    jsonb_build_object('stage', 'needs_offer', 'motivationKind', p_motivation_kind)
  );
  return v_result;
end;
$$;

create or replace function public.fn_log_acquisition_offer(
  p_org_id uuid,
  p_property_id uuid,
  p_expected_episode_id uuid,
  p_expected_queue_version bigint,
  p_expected_shared_status text,
  p_idempotency_key uuid,
  p_amount_cents bigint,
  p_sent_via text,
  p_sent_at timestamptz,
  p_follow_up_at timestamptz,
  p_motivation_kind text default null,
  p_motivation_text text default null,
  p_temperature text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_offer_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_pending public.acquisition_offers%rowtype;
  v_role text;
  v_queue_exists boolean;
  v_episode_exists boolean;
  v_version bigint;
  v_kind text;
  v_text text;
begin
  if p_property_id is null or p_expected_episode_id is null
     or p_expected_queue_version is null or p_expected_queue_version < 0
     or p_expected_shared_status is null or p_idempotency_key is null
     or p_amount_cents is null or p_amount_cents <= 0
     or p_sent_via not in ('dropbox_sign', 'verbal', 'email_text')
     or p_sent_at is null or p_follow_up_at is null
     or not isfinite(p_sent_at) or not isfinite(p_follow_up_at)
     or p_sent_at > statement_timestamp() or p_follow_up_at <= p_sent_at then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_temperature is not null and p_temperature not in ('hot', 'warm', 'cold') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_motivation_kind is not null then
    perform public.my_leads_workflow_assert_motivation(p_motivation_kind, p_motivation_text);
  elsif p_motivation_text is not null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := public.my_leads_command_hash(
    'log_acquisition_offer', p_org_id, v_actor,
    jsonb_build_object(
      'propertyId', p_property_id, 'expectedEpisodeId', p_expected_episode_id,
      'expectedQueueVersion', p_expected_queue_version,
      'expectedSharedStatus', p_expected_shared_status, 'amountCents', p_amount_cents,
      'sentVia', p_sent_via, 'sentAt', p_sent_at, 'followUpAt', p_follow_up_at,
      'motivationKind', p_motivation_kind, 'motivationText', p_motivation_text,
      'temperature', p_temperature
    )
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'log_acquisition_offer', p_idempotency_key), 0
  ));
  v_replay := public.my_leads_workflow_replay(
    p_org_id, 'log_acquisition_offer', p_idempotency_key, v_actor, v_hash
  );
  if v_replay is not null then return v_replay; end if;
  if not exists (select 1 from public.acquisition_org_settings s where s.org_id = p_org_id and s.my_leads_enabled) then
    raise exception 'FEATURE_DISABLED' using errcode = '42501';
  end if;

  select * into v_property from public.properties p
  where p.id = p_property_id and p.org_id = p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_property.is_dnc_locked or v_property.outreach_dispo = 'dnc' then
    raise exception 'DNC_LOCKED' using errcode = '42501';
  end if;
  if v_property.status is distinct from p_expected_shared_status then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;
  select m.role into v_role from public.memberships m
  where m.org_id = p_org_id and m.user_id = v_actor and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_role <> 'owner' and v_property.assigned_user_id is distinct from v_actor then
    raise exception 'STALE_ASSIGNMENT' using errcode = '40001';
  end if;
  if v_property.status in ('offer_declined', 'under_contract', 'closed', 'dead') then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  select * into v_queue from public.acquisition_queue_states q
  where q.org_id = p_org_id and q.property_id = p_property_id for update;
  v_queue_exists := found;
  v_version := coalesce(v_queue.version, 0);
  if v_version <> p_expected_queue_version then raise exception 'STALE_STATE' using errcode = '40001'; end if;
  if v_queue.archived_at is not null or v_queue.stage = 'under_contract' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;
  select * into v_episode from public.acquisition_assignment_episodes e
  where e.org_id = p_org_id and e.property_id = p_property_id and e.ended_at is null for update;
  v_episode_exists := found;
  if not v_episode_exists or v_episode.id is distinct from p_expected_episode_id then
    raise exception 'STALE_ASSIGNMENT' using errcode = '40001';
  end if;
  select * into v_pending from public.acquisition_offers o
  where o.org_id = p_org_id and o.property_id = p_property_id and o.outcome = 'pending'
  for update;
  if found then raise exception 'PENDING_OFFER_EXISTS' using errcode = '40001'; end if;

  if v_queue.motivation_recorded then
    if p_motivation_kind is not null and (
      v_queue.motivation_kind is distinct from p_motivation_kind or
      v_queue.motivation_text is distinct from nullif(btrim(p_motivation_text), '')
    ) then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
    v_kind := v_queue.motivation_kind;
    v_text := v_queue.motivation_text;
  else
    if p_motivation_kind is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
    perform public.my_leads_workflow_assert_motivation(p_motivation_kind, p_motivation_text);
    v_kind := p_motivation_kind;
    v_text := case when p_motivation_kind = 'specified' then btrim(p_motivation_text) end;
  end if;
  -- Offers retain their originating command through a composite FK. Reserve
  -- the receipt before inserting the fact, then fill its result after all
  -- state changes have succeeded.
  insert into public.acquisition_commands (
    id, org_id, actor_user_id, actor_kind, operation, idempotency_key, request_hash, result
  ) values (
    v_command_id, p_org_id, v_actor, 'user', 'log_acquisition_offer',
    p_idempotency_key, v_hash, '{}'::jsonb
  );
  if v_queue_exists then
    update public.acquisition_queue_states q
    set stage = 'offer_sent', stage_entered_at = p_sent_at,
        motivation_recorded = true, motivation_kind = v_kind, motivation_text = v_text,
        motivation_recorded_at = coalesce(q.motivation_recorded_at, statement_timestamp()),
        motivation_recorded_by = coalesce(q.motivation_recorded_by, v_actor),
        version = q.version + 1, updated_at = statement_timestamp()
    where q.org_id = p_org_id and q.property_id = p_property_id;
  else
    insert into public.acquisition_queue_states (
      org_id, property_id, stage, stage_entered_at, motivation_recorded,
      motivation_kind, motivation_text, motivation_recorded_at, motivation_recorded_by, version
    ) values (
      p_org_id, p_property_id, 'offer_sent', p_sent_at, true, v_kind, v_text,
      statement_timestamp(), v_actor, 1
    );
  end if;
  if p_temperature is not null then
    update public.properties set motivation_level = p_temperature where id = p_property_id and org_id = p_org_id;
  end if;
  insert into public.acquisition_offers (
    id, org_id, property_id, assignment_episode_id, actor_user_id,
    amount_cents, sent_via, sent_at, follow_up_at, idempotency_key, command_id
  ) values (
    v_offer_id, p_org_id, p_property_id, v_episode.id, v_actor,
    p_amount_cents, p_sent_via, p_sent_at, p_follow_up_at, p_idempotency_key, v_command_id
  );
  update public.properties set status = 'offer_sent', updated_at = statement_timestamp()
  where id = p_property_id and org_id = p_org_id
    and status in ('prospect', 'new_lead', 'contacted', 'interested');
  v_result := jsonb_build_object(
    'ok', true, 'duplicate', false, 'propertyId', p_property_id,
    'queueVersion', v_version + 1, 'stage', 'offer_sent', 'archived', false,
    'offerId', v_offer_id, 'assignmentEpisodeId', v_episode.id
  );
  update public.acquisition_commands set result = v_result
  where id = v_command_id and org_id = p_org_id;
  perform public.my_leads_workflow_append_event(
    p_org_id, p_property_id, v_actor, v_command_id, 'log_acquisition_offer',
    jsonb_build_object('offerId', v_offer_id, 'stage', 'offer_sent')
  );
  return v_result;
end;
$$;

create or replace function public.fn_record_acquisition_contract(
  p_org_id uuid,
  p_property_id uuid,
  p_expected_episode_id uuid,
  p_expected_queue_version bigint,
  p_expected_shared_status text,
  p_idempotency_key uuid,
  p_signed_at timestamptz,
  p_offer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_offer public.acquisition_offers%rowtype;
  v_role text;
  v_version bigint;
  v_queue_exists boolean;
begin
  if p_property_id is null or p_expected_episode_id is null or p_expected_queue_version is null
     or p_expected_queue_version < 0 or p_expected_shared_status is null
     or p_idempotency_key is null or p_signed_at is null
     or not isfinite(p_signed_at) or p_signed_at > statement_timestamp() then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := public.my_leads_command_hash(
    'record_acquisition_contract', p_org_id, v_actor,
    jsonb_build_object('propertyId', p_property_id, 'expectedEpisodeId', p_expected_episode_id,
      'expectedQueueVersion', p_expected_queue_version, 'expectedSharedStatus', p_expected_shared_status,
      'signedAt', p_signed_at, 'offerId', p_offer_id)
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'record_acquisition_contract', p_idempotency_key), 0
  ));
  v_replay := public.my_leads_workflow_replay(p_org_id, 'record_acquisition_contract', p_idempotency_key, v_actor, v_hash);
  if v_replay is not null then return v_replay; end if;
  if not exists (select 1 from public.acquisition_org_settings s where s.org_id = p_org_id and s.my_leads_enabled) then
    raise exception 'FEATURE_DISABLED' using errcode = '42501';
  end if;
  select * into v_property from public.properties p where p.id=p_property_id and p.org_id=p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_property.is_dnc_locked or v_property.outreach_dispo='dnc' then raise exception 'DNC_LOCKED' using errcode='42501'; end if;
  if v_property.status is distinct from p_expected_shared_status then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select m.role into v_role from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor
    and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_role<>'owner' and v_property.assigned_user_id is distinct from v_actor then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  if v_property.status in ('offer_declined','closed','dead','under_contract') then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_queue from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id for update;
  v_queue_exists := found;
  if not v_queue_exists and p_expected_queue_version <> 0 then
    raise exception 'STALE_STATE' using errcode='40001';
  end if;
  v_version := coalesce(v_queue.version,0);
  if v_version<>p_expected_queue_version or v_queue.archived_at is not null or v_queue.stage='under_contract' then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.property_id=p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  if p_offer_id is not null then
    select * into v_offer from public.acquisition_offers o where o.id=p_offer_id and o.org_id=p_org_id and o.property_id=p_property_id for update;
    if not found or v_offer.assignment_episode_id is distinct from v_episode.id or v_offer.outcome<>'pending' then raise exception 'STALE_STATE' using errcode='40001'; end if;
  end if;
  if v_queue_exists then
    update public.acquisition_queue_states q
    set stage='under_contract', stage_entered_at=p_signed_at,
        signed_at=p_signed_at, signed_by=v_actor, version=q.version+1, updated_at=statement_timestamp()
    where q.org_id=p_org_id and q.property_id=p_property_id;
  else
    insert into public.acquisition_queue_states (
      org_id, property_id, stage, stage_entered_at, signed_at, signed_by, version
    ) values (
      p_org_id, p_property_id, 'under_contract', p_signed_at, p_signed_at, v_actor, 1
    );
  end if;
  if p_offer_id is not null then
    update public.acquisition_offers set outcome='accepted', outcome_at=p_signed_at, outcome_by=v_actor, updated_at=statement_timestamp()
    where id=p_offer_id and org_id=p_org_id and property_id=p_property_id;
  end if;
  update public.properties set status='under_contract', updated_at=statement_timestamp()
  where id=p_property_id and org_id=p_org_id and status in ('prospect','new_lead','contacted','interested','offer_sent');
  v_result := jsonb_build_object('ok',true,'duplicate',false,'propertyId',p_property_id,
    'queueVersion',v_version+1,'stage','under_contract','archived',false,'assignmentEpisodeId',v_episode.id);
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command_id,p_org_id,v_actor,'user','record_acquisition_contract',p_idempotency_key,v_hash,v_result);
  perform public.my_leads_workflow_append_event(p_org_id,p_property_id,v_actor,v_command_id,'record_acquisition_contract',jsonb_build_object('stage','under_contract','offerId',p_offer_id));
  return v_result;
end;
$$;

create or replace function public.fn_decline_acquisition_offer(
  p_org_id uuid,
  p_property_id uuid,
  p_expected_episode_id uuid,
  p_expected_queue_version bigint,
  p_expected_shared_status text,
  p_idempotency_key uuid,
  p_offer_id uuid,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_offer public.acquisition_offers%rowtype;
  v_settings public.acquisition_org_settings%rowtype;
  v_role text;
  v_version bigint;
begin
  if p_property_id is null or p_expected_episode_id is null or p_expected_queue_version is null
     or p_expected_queue_version < 0 or p_expected_shared_status is null
     or p_idempotency_key is null or p_offer_id is null or p_occurred_at is null
     or not isfinite(p_occurred_at) or p_occurred_at > statement_timestamp() then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  v_hash := public.my_leads_command_hash('decline_acquisition_offer',p_org_id,v_actor,jsonb_build_object(
    'propertyId',p_property_id,'expectedEpisodeId',p_expected_episode_id,'expectedQueueVersion',p_expected_queue_version,
    'expectedSharedStatus',p_expected_shared_status,'offerId',p_offer_id,'occurredAt',p_occurred_at));
  perform pg_advisory_xact_lock(hashtextextended(format('my-leads:%s:%s:%s',p_org_id,'decline_acquisition_offer',p_idempotency_key),0));
  v_replay := public.my_leads_workflow_replay(p_org_id,'decline_acquisition_offer',p_idempotency_key,v_actor,v_hash);
  if v_replay is not null then return v_replay; end if;
  if not exists (select 1 from public.acquisition_org_settings s where s.org_id=p_org_id and s.my_leads_enabled) then raise exception 'FEATURE_DISABLED' using errcode='42501'; end if;
  select * into v_property from public.properties p where p.id=p_property_id and p.org_id=p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_property.is_dnc_locked or v_property.outreach_dispo='dnc' then raise exception 'DNC_LOCKED' using errcode='42501'; end if;
  if v_property.status is distinct from p_expected_shared_status then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select m.role into v_role from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor and m.access_status='active'
    and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_role<>'owner' and v_property.assigned_user_id is distinct from v_actor then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  if v_property.status in ('closed','dead','under_contract','offer_declined') then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_queue from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id for update;
  if not found then raise exception 'STALE_STATE' using errcode='40001'; end if;
  v_version:=coalesce(v_queue.version,0);
  if v_version<>p_expected_queue_version or v_queue.archived_at is not null then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.property_id=p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  select * into v_offer from public.acquisition_offers o where o.id=p_offer_id and o.org_id=p_org_id and o.property_id=p_property_id for update;
  if not found or v_offer.assignment_episode_id is distinct from v_episode.id or v_offer.outcome<>'pending' then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_settings from public.acquisition_org_settings s where s.org_id=p_org_id;
  if not found or v_settings.needs_sequence_owner_id is null or not exists (
    select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=v_settings.needs_sequence_owner_id and m.access_status='active'
      and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
  ) then raise exception 'RECIPIENT_UNAVAILABLE' using errcode='22023'; end if;
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command_id,p_org_id,v_actor,'user','decline_acquisition_offer',p_idempotency_key,v_hash,'{}');
  update public.acquisition_offers set outcome='declined',outcome_at=p_occurred_at,outcome_by=v_actor,updated_at=statement_timestamp()
    where id=p_offer_id and org_id=p_org_id and property_id=p_property_id;
  update public.acquisition_queue_states q set archived_at=statement_timestamp(),archived_by=v_actor,archive_reason='needs_sequence_handoff',version=q.version+1,updated_at=statement_timestamp()
    where q.org_id=p_org_id and q.property_id=p_property_id;
  perform set_config('my_leads.handoff_property_id',format('%s:%s',p_property_id,v_command_id),true);
  update public.properties set status='offer_declined',outreach_dispo='needs_sequence',assigned_user_id=v_settings.needs_sequence_owner_id,updated_at=statement_timestamp()
    where id=p_property_id and org_id=p_org_id and assigned_user_id is not distinct from v_property.assigned_user_id;
  if not found then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  perform set_config('my_leads.handoff_property_id','',true);
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',p_property_id,'queueVersion',v_version+1,'stage',v_queue.stage,'archived',true,'assignmentEpisodeId',v_episode.id);
  update public.acquisition_commands set result=v_result where id=v_command_id and org_id=p_org_id;
  perform public.my_leads_workflow_append_event(p_org_id,p_property_id,v_actor,v_command_id,'decline_acquisition_offer',jsonb_build_object('status','offer_declined','disposition','needs_sequence','recipientUserId',v_settings.needs_sequence_owner_id));
  return v_result;
end;
$$;

create or replace function public.fn_handoff_acquisition_lead(
  p_org_id uuid,
  p_property_id uuid,
  p_expected_episode_id uuid,
  p_expected_queue_version bigint,
  p_expected_shared_status text,
  p_idempotency_key uuid,
  p_reason text,
  p_recipient_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_settings public.acquisition_org_settings%rowtype;
  v_role text;
  v_version bigint;
begin
  if p_property_id is null or p_expected_episode_id is null or p_expected_queue_version is null or p_expected_queue_version<0
     or p_expected_shared_status is null or p_idempotency_key is null or p_reason not in ('not_interested','needs_nurture') or p_recipient_user_id is null then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  v_hash:=public.my_leads_command_hash('handoff_acquisition_lead',p_org_id,v_actor,jsonb_build_object(
    'propertyId',p_property_id,'expectedEpisodeId',p_expected_episode_id,'expectedQueueVersion',p_expected_queue_version,
    'expectedSharedStatus',p_expected_shared_status,'reason',p_reason,'recipientUserId',p_recipient_user_id));
  perform pg_advisory_xact_lock(hashtextextended(format('my-leads:%s:%s:%s',p_org_id,'handoff_acquisition_lead',p_idempotency_key),0));
  v_replay:=public.my_leads_workflow_replay(p_org_id,'handoff_acquisition_lead',p_idempotency_key,v_actor,v_hash);
  if v_replay is not null then return v_replay; end if;
  if not exists(select 1 from public.acquisition_org_settings s where s.org_id=p_org_id and s.my_leads_enabled) then raise exception 'FEATURE_DISABLED' using errcode='42501'; end if;
  select * into v_property from public.properties p where p.id=p_property_id and p.org_id=p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_property.is_dnc_locked or v_property.outreach_dispo='dnc' then raise exception 'DNC_LOCKED' using errcode='42501'; end if;
  if v_property.status is distinct from p_expected_shared_status then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select m.role into v_role from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor and m.access_status='active'
    and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_role<>'owner' and v_property.assigned_user_id is distinct from v_actor then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  if v_property.status in ('closed','dead','under_contract') then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_queue from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id for update;
  if not found then raise exception 'STALE_STATE' using errcode='40001'; end if;
  v_version:=coalesce(v_queue.version,0);
  if v_version<>p_expected_queue_version or v_queue.archived_at is not null then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.property_id=p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  select * into v_settings from public.acquisition_org_settings s where s.org_id=p_org_id;
  if not found or v_settings.needs_sequence_owner_id is distinct from p_recipient_user_id or not exists(
    select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_recipient_user_id and m.access_status='active'
      and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
  ) then raise exception 'RECIPIENT_UNAVAILABLE' using errcode='22023'; end if;
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command_id,p_org_id,v_actor,'user','handoff_acquisition_lead',p_idempotency_key,v_hash,'{}');
  update public.acquisition_queue_states q set archived_at=statement_timestamp(),archived_by=v_actor,archive_reason='needs_sequence_handoff',version=q.version+1,updated_at=statement_timestamp()
    where q.org_id=p_org_id and q.property_id=p_property_id;
  perform set_config('my_leads.handoff_property_id',format('%s:%s',p_property_id,v_command_id),true);
  update public.properties set outreach_dispo='needs_sequence',assigned_user_id=p_recipient_user_id,updated_at=statement_timestamp()
    where id=p_property_id and org_id=p_org_id and assigned_user_id is not distinct from v_property.assigned_user_id;
  if not found then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  perform set_config('my_leads.handoff_property_id','',true);
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',p_property_id,'queueVersion',v_version+1,'stage',v_queue.stage,'archived',true,'assignmentEpisodeId',v_episode.id);
  update public.acquisition_commands set result=v_result where id=v_command_id and org_id=p_org_id;
  perform public.my_leads_workflow_append_event(p_org_id,p_property_id,v_actor,v_command_id,'handoff_acquisition_lead',jsonb_build_object('disposition','needs_sequence','reason',p_reason,'recipientUserId',p_recipient_user_id));
  return v_result;
end;
$$;

create or replace function public.fn_archive_acquisition_contract(
  p_org_id uuid,
  p_property_id uuid,
  p_expected_episode_id uuid,
  p_expected_queue_version bigint,
  p_expected_shared_status text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_role text;
  v_version bigint;
begin
  if p_property_id is null or p_expected_episode_id is null or p_expected_queue_version is null or p_expected_queue_version<0 or p_expected_shared_status is null or p_idempotency_key is null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  v_hash:=public.my_leads_command_hash('archive_acquisition_contract',p_org_id,v_actor,jsonb_build_object('propertyId',p_property_id,'expectedEpisodeId',p_expected_episode_id,'expectedQueueVersion',p_expected_queue_version,'expectedSharedStatus',p_expected_shared_status));
  perform pg_advisory_xact_lock(hashtextextended(format('my-leads:%s:%s:%s',p_org_id,'archive_acquisition_contract',p_idempotency_key),0));
  v_replay:=public.my_leads_workflow_replay(p_org_id,'archive_acquisition_contract',p_idempotency_key,v_actor,v_hash);
  if v_replay is not null then return v_replay; end if;
  if not exists(select 1 from public.acquisition_org_settings s where s.org_id=p_org_id and s.my_leads_enabled) then raise exception 'FEATURE_DISABLED' using errcode='42501'; end if;
  select * into v_property from public.properties p where p.id=p_property_id and p.org_id=p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_property.status is distinct from p_expected_shared_status or v_property.status<>'under_contract' then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select m.role into v_role from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor and m.access_status='active'
    and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_role<>'owner' and v_property.assigned_user_id is distinct from v_actor then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  select * into v_queue from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id for update;
  if not found or v_queue.stage<>'under_contract' or v_queue.archived_at is not null then raise exception 'STALE_STATE' using errcode='40001'; end if;
  v_version:=coalesce(v_queue.version,0);
  if v_version<>p_expected_queue_version then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.property_id=p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  update public.acquisition_queue_states q set archived_at=statement_timestamp(),archived_by=v_actor,archive_reason='under_contract_archived',version=q.version+1,updated_at=statement_timestamp()
    where q.org_id=p_org_id and q.property_id=p_property_id;
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',p_property_id,'queueVersion',v_version+1,'stage','under_contract','archived',true,'assignmentEpisodeId',v_episode.id);
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command_id,p_org_id,v_actor,'user','archive_acquisition_contract',p_idempotency_key,v_hash,v_result);
  perform public.my_leads_workflow_append_event(p_org_id,p_property_id,v_actor,v_command_id,'archive_acquisition_contract',jsonb_build_object('stage','under_contract','archived',true));
  return v_result;
end;
$$;

revoke all on function public.fn_ready_acquisition_offer(uuid,uuid,uuid,bigint,text,uuid,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_ready_acquisition_offer(uuid,uuid,uuid,bigint,text,uuid,text,text,text)
  to authenticated;
revoke all on function public.fn_log_acquisition_offer(uuid,uuid,uuid,bigint,text,uuid,bigint,text,timestamptz,timestamptz,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_log_acquisition_offer(uuid,uuid,uuid,bigint,text,uuid,bigint,text,timestamptz,timestamptz,text,text,text)
  to authenticated;
revoke all on function public.fn_record_acquisition_contract(uuid,uuid,uuid,bigint,text,uuid,timestamptz,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_record_acquisition_contract(uuid,uuid,uuid,bigint,text,uuid,timestamptz,uuid)
  to authenticated;
revoke all on function public.fn_decline_acquisition_offer(uuid,uuid,uuid,bigint,text,uuid,uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_decline_acquisition_offer(uuid,uuid,uuid,bigint,text,uuid,uuid,timestamptz)
  to authenticated;
revoke all on function public.fn_handoff_acquisition_lead(uuid,uuid,uuid,bigint,text,uuid,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_handoff_acquisition_lead(uuid,uuid,uuid,bigint,text,uuid,text,uuid)
  to authenticated;
revoke all on function public.fn_archive_acquisition_contract(uuid,uuid,uuid,bigint,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_archive_acquisition_contract(uuid,uuid,uuid,bigint,text,uuid)
  to authenticated;

-- The application boundary accepts one frozen JSON envelope per command. The
-- scalar functions above are private implementation entry points; keeping the
-- decoding here makes the server action's wire contract stable and prevents a
-- caller from omitting a required CAS field by relying on a SQL default.
create or replace function public.fn_ready_acquisition_offer(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return public.fn_ready_acquisition_offer(
    (p_input->>'orgId')::uuid,
    (p_input->>'propertyId')::uuid,
    (p_input->>'expectedEpisodeId')::uuid,
    (p_input->>'expectedQueueVersion')::bigint,
    p_input->>'expectedSharedStatus',
    (p_input->>'idempotencyKey')::uuid,
    p_input->'motivationResponse'->>'kind',
    p_input->'motivationResponse'->>'text',
    p_input->>'temperature'
  );
end;
$$;

create or replace function public.fn_log_acquisition_offer(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return public.fn_log_acquisition_offer(
    (p_input->>'orgId')::uuid,
    (p_input->>'propertyId')::uuid,
    (p_input->>'expectedEpisodeId')::uuid,
    (p_input->>'expectedQueueVersion')::bigint,
    p_input->>'expectedSharedStatus',
    (p_input->>'idempotencyKey')::uuid,
    (p_input->>'amountCents')::bigint,
    p_input->>'method',
    (p_input->>'sentAt')::timestamptz,
    (p_input->>'followUpAt')::timestamptz,
    p_input->'motivationResponse'->>'kind',
    p_input->'motivationResponse'->>'text',
    p_input->>'temperature'
  );
end;
$$;

create or replace function public.fn_record_acquisition_contract(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return public.fn_record_acquisition_contract(
    (p_input->>'orgId')::uuid,
    (p_input->>'propertyId')::uuid,
    (p_input->>'expectedEpisodeId')::uuid,
    (p_input->>'expectedQueueVersion')::bigint,
    p_input->>'expectedSharedStatus',
    (p_input->>'idempotencyKey')::uuid,
    (p_input->>'signedAt')::timestamptz,
    (p_input->>'offerId')::uuid
  );
end;
$$;

create or replace function public.fn_decline_acquisition_offer(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return public.fn_decline_acquisition_offer(
    (p_input->>'orgId')::uuid,
    (p_input->>'propertyId')::uuid,
    (p_input->>'expectedEpisodeId')::uuid,
    (p_input->>'expectedQueueVersion')::bigint,
    p_input->>'expectedSharedStatus',
    (p_input->>'idempotencyKey')::uuid,
    coalesce((p_input->>'pendingOfferId')::uuid, (p_input->>'offerId')::uuid),
    (p_input->>'occurredAt')::timestamptz
  );
end;
$$;

create or replace function public.fn_handoff_acquisition_lead(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return public.fn_handoff_acquisition_lead(
    (p_input->>'orgId')::uuid,
    (p_input->>'propertyId')::uuid,
    (p_input->>'expectedEpisodeId')::uuid,
    (p_input->>'expectedQueueVersion')::bigint,
    p_input->>'expectedSharedStatus',
    (p_input->>'idempotencyKey')::uuid,
    p_input->>'reason',
    (p_input->>'recipientUserId')::uuid
  );
end;
$$;

create or replace function public.fn_archive_acquisition_contract(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return public.fn_archive_acquisition_contract(
    (p_input->>'orgId')::uuid,
    (p_input->>'propertyId')::uuid,
    (p_input->>'expectedEpisodeId')::uuid,
    (p_input->>'expectedQueueVersion')::bigint,
    p_input->>'expectedSharedStatus',
    (p_input->>'idempotencyKey')::uuid
  );
end;
$$;

revoke all on function public.fn_ready_acquisition_offer(jsonb)
  from public, anon, service_role;
grant execute on function public.fn_ready_acquisition_offer(jsonb) to authenticated;
revoke all on function public.fn_log_acquisition_offer(jsonb)
  from public, anon, service_role;
grant execute on function public.fn_log_acquisition_offer(jsonb) to authenticated;
revoke all on function public.fn_record_acquisition_contract(jsonb)
  from public, anon, service_role;
grant execute on function public.fn_record_acquisition_contract(jsonb) to authenticated;
revoke all on function public.fn_decline_acquisition_offer(jsonb)
  from public, anon, service_role;
grant execute on function public.fn_decline_acquisition_offer(jsonb) to authenticated;
revoke all on function public.fn_handoff_acquisition_lead(jsonb)
  from public, anon, service_role;
grant execute on function public.fn_handoff_acquisition_lead(jsonb) to authenticated;
revoke all on function public.fn_archive_acquisition_contract(jsonb)
  from public, anon, service_role;
grant execute on function public.fn_archive_acquisition_contract(jsonb) to authenticated;

commit;
