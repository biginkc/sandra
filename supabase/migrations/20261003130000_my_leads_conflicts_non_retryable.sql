begin;

-- Stop PostgREST retry storms on definite My Leads business conflicts.
--
-- These functions raised definite conflicts (STALE_STATE, STALE_ASSIGNMENT,
-- IDEMPOTENCY_CONFLICT, PENDING_OFFER_EXISTS, LAUNCH_*, ROLLBACK_BLOCKED, ...)
-- with SQLSTATE 40001 (serialization_failure). PostgREST re-runs a transaction
-- that fails with 40001, so a stale save re-ran until the request timed out
-- (production 2026-10-03: 1,512 STALE_STATE raises from 2 HTTP calls).
-- A retry can never turn a stale check into a success.
--
-- Each function below is the latest deployed definition, unchanged except that
-- `errcode='40001'` is now the dedicated, non-retryable `MLS01` ("My Leads
-- conflict"). Messages are unchanged, so message-based clients keep working.
-- create or replace preserves owners and grants. Genuine serialization
-- failures raised by Postgres itself are untouched.

-- fn_set_acquisition_designation(uuid,uuid,boolean,boolean,uuid) (2 raise sites)
CREATE OR REPLACE FUNCTION public.fn_set_acquisition_designation(p_org_id uuid, p_user_id uuid, p_enabled boolean, p_expected_enabled boolean, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_hash text;
  v_result jsonb;
  v_existing public.acquisition_commands%rowtype;
begin
  if v_actor is null or p_org_id is null or p_user_id is null
     or p_expected_enabled is null
     or p_idempotency_key is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  -- Authenticate the caller/org before any replay. Replay may not grant a
  -- newly unauthorized caller access to a prior result.
  if not exists (
    select 1
    from public.memberships m
    where m.user_id = v_actor
      and m.org_id = p_org_id
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  v_hash := public.my_leads_command_hash(
    'set_acquisition_designation',
    p_org_id,
    v_actor,
    jsonb_build_object(
      'user_id', p_user_id,
      'enabled', p_enabled,
      'expected_enabled', p_expected_enabled
    )
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'set_acquisition_designation', p_idempotency_key),
    0
  ));

  select * into v_existing
  from public.acquisition_commands c
  where c.org_id = p_org_id
    and c.operation = 'set_acquisition_designation'
    and c.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_existing.actor_user_id is distinct from v_actor
       or v_existing.request_hash is distinct from v_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'MLS01';
    end if;
    return jsonb_set(v_existing.result, '{duplicate}', 'true'::jsonb, true);
  end if;

  -- Lock the target after the command identity and compare the designation
  -- under that lock. This prevents two owner tabs from silently losing a
  -- toggle while retaining the successful replay result.
  if not exists (
    select 1
    from public.memberships m
    where m.user_id = p_user_id and m.org_id = p_org_id
    for update
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;
  if (select m.acquisitions_enabled from public.memberships m
      where m.user_id = p_user_id and m.org_id = p_org_id)
      is distinct from p_expected_enabled then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;
  if not exists (
    select 1
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.user_id = p_user_id
      and m.org_id = p_org_id
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
      and coalesce(
        nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
        nullif(btrim(u.email), '')
      ) is not null
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;

  perform set_config(
    'my_leads.designation_update',
    format('%s:%s:%s', v_actor, p_org_id, p_user_id),
    true
  );
  update public.memberships
  set acquisitions_enabled = p_enabled
  where user_id = p_user_id and org_id = p_org_id;
  perform set_config('my_leads.designation_update', '', true);

  v_result := jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'orgId', p_org_id,
    'userId', p_user_id,
    'acquisitionsEnabled', p_enabled
  );
  insert into public.acquisition_commands (
    org_id, actor_user_id, actor_kind, operation, idempotency_key,
    request_hash, result
  ) values (
    p_org_id, v_actor, 'user', 'set_acquisition_designation',
    p_idempotency_key, v_hash, v_result
  );
  return v_result;
end;
$function$;

-- fn_set_acquisition_settings(uuid,uuid,bigint,uuid) (2 raise sites)
CREATE OR REPLACE FUNCTION public.fn_set_acquisition_settings(p_org_id uuid, p_needs_sequence_owner_id uuid, p_expected_settings_revision bigint, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_hash text;
  v_result jsonb;
  v_enabled boolean;
  v_revision bigint;
  v_existing public.acquisition_commands%rowtype;
  v_current_revision bigint := 0;
  v_settings_exists boolean := false;
begin
  if v_actor is null or p_org_id is null or p_needs_sequence_owner_id is null
     or p_expected_settings_revision is null or p_expected_settings_revision < 0
     or p_idempotency_key is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_actor and m.org_id = p_org_id and m.role = 'owner'
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  v_hash := public.my_leads_command_hash(
    'set_acquisition_settings', p_org_id, v_actor,
    jsonb_build_object(
      'needs_sequence_owner_id', p_needs_sequence_owner_id,
      'expected_settings_revision', p_expected_settings_revision
    )
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'set_acquisition_settings', p_idempotency_key),
    0
  ));
  select * into v_existing from public.acquisition_commands c
  where c.org_id = p_org_id and c.operation = 'set_acquisition_settings'
    and c.idempotency_key = p_idempotency_key for update;
  if found then
    if v_existing.actor_user_id is distinct from v_actor
       or v_existing.request_hash is distinct from v_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'MLS01';
    end if;
    return jsonb_set(v_existing.result, '{duplicate}', 'true'::jsonb, true);
  end if;
  -- Organization settings are the next lock in the org-level command order.
  select s.settings_revision into v_current_revision
  from public.acquisition_org_settings s
  where s.org_id = p_org_id
  for update;
  v_settings_exists := found;
  if v_current_revision is distinct from p_expected_settings_revision
     and not (not v_settings_exists and p_expected_settings_revision = 0) then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;

  -- The recipient is locked after settings so concurrent owner changes cannot
  -- validate a member that is being revoked or expired in the same window.
  if not exists (
    select 1 from public.memberships m
    where m.user_id = p_needs_sequence_owner_id and m.org_id = p_org_id
    for update
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.user_id = p_needs_sequence_owner_id and m.org_id = p_org_id
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
      and coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                   nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                   nullif(btrim(u.email), '')) is not null
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;

  insert into public.acquisition_org_settings (org_id, needs_sequence_owner_id)
  values (p_org_id, p_needs_sequence_owner_id)
  on conflict (org_id) do update
  set needs_sequence_owner_id = excluded.needs_sequence_owner_id,
      settings_revision = public.acquisition_org_settings.settings_revision + 1,
      updated_at = statement_timestamp();

  select s.my_leads_enabled into v_enabled
  from public.acquisition_org_settings s
  where s.org_id = p_org_id;
  select s.settings_revision into v_revision
  from public.acquisition_org_settings s
  where s.org_id = p_org_id;

  v_result := jsonb_build_object(
    'ok', true, 'duplicate', false, 'orgId', p_org_id,
    'needsSequenceOwnerId', p_needs_sequence_owner_id,
    'myLeadsEnabled', coalesce(v_enabled, false),
    'settingsRevision', coalesce(v_revision, 0)
  );
  insert into public.acquisition_commands (
    org_id, actor_user_id, actor_kind, operation, idempotency_key,
    request_hash, result
  ) values (
    p_org_id, v_actor, 'user', 'set_acquisition_settings',
    p_idempotency_key, v_hash, v_result
  );
  return v_result;
end;
$function$;

-- fn_bind_acquisition_call_context(uuid,uuid,uuid,text) (1 raise sites)
CREATE OR REPLACE FUNCTION public.fn_bind_acquisition_call_context(p_org_id uuid, p_property_id uuid, p_actor_user_id uuid, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_property public.properties%rowtype;
  v_episode uuid;
  v_existing public.acquisition_commands%rowtype;
  v_result jsonb;
  v_hash text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := public.my_leads_command_hash('bind_call_context', p_org_id, p_actor_user_id, jsonb_build_object('propertyId',p_property_id,'tokenHash',p_token_hash));
  perform pg_advisory_xact_lock(hashtextextended('my-leads:call:' || p_org_id::text || ':' || p_token_hash,0));
  select * into v_existing from public.acquisition_commands
    where org_id=p_org_id and operation='bind_call_context' and context_key_hash=p_token_hash;
  if found then
    if v_existing.request_hash <> v_hash then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='MLS01'; end if;
    return v_existing.result;
  end if;
  if not exists(select 1 from public.acquisition_org_settings where org_id=p_org_id and my_leads_enabled) then
    return jsonb_build_object('tracked',false);
  end if;
  select * into v_property from public.properties where id=p_property_id and org_id=p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_actor_user_id
      and m.access_status='active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  select id into v_episode from public.acquisition_assignment_episodes
    where property_id=p_property_id and org_id=p_org_id and ended_at is null for update;
  v_result := jsonb_build_object('tracked',true,'orgId',p_org_id,'propertyId',p_property_id,
    'actorUserId',p_actor_user_id,'assignmentEpisodeId',v_episode);
  insert into public.acquisition_commands(org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,context_key_hash,result)
    values(p_org_id,p_actor_user_id,'user','bind_call_context',extensions.gen_random_uuid(),v_hash,p_token_hash,v_result);
  return v_result;
end;
$function$;

-- fn_record_acquisition_call_start(jsonb) (2 raise sites)
CREATE OR REPLACE FUNCTION public.fn_record_acquisition_call_start(p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := (p_event->>'orgId')::uuid;
  v_property_id uuid := (p_event->>'propertyId')::uuid;
  v_actor uuid := (p_event->>'actorUserId')::uuid;
  v_episode_id uuid := (p_event->>'assignmentEpisodeId')::uuid;
  v_at timestamptz := (p_event->>'occurredAt')::timestamptz;
  v_token text := p_event->>'tokenHash';
  v_binding public.acquisition_commands%rowtype;
  v_receipt public.acquisition_commands%rowtype;
  v_attempt public.acquisition_attempts%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_hash text;
  v_result jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
begin
  if v_org is null or v_property_id is null or v_actor is null or v_at is null or not isfinite(v_at)
    or v_token is null or v_token !~ '^[0-9a-f]{64}$'
    or p_event->>'evidence' is distinct from 'seller_call_create_succeeded'
    or p_event->>'eventVersion' is distinct from '1'
    or nullif(p_event->>'jitterCallId','') is null or nullif(p_event->>'sellerProviderCallId','') is null then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('my-leads:call:' || v_org::text || ':' || v_token,0));
  select * into v_binding from public.acquisition_commands
    where org_id=v_org and operation='bind_call_context' and context_key_hash=v_token;
  if not found then raise exception 'CALL_CONTEXT_MISSING' using errcode='P0002'; end if;
  if (v_binding.result->>'propertyId')::uuid is distinct from v_property_id
    or (v_binding.result->>'actorUserId')::uuid is distinct from v_actor
    or (v_binding.result->>'assignmentEpisodeId')::uuid is distinct from v_episode_id then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  -- A provider event UUID is a transport envelope, not a second logical call.
  v_hash := public.my_leads_command_hash('record_call_start',v_org,v_actor,p_event - 'eventId');
  select * into v_receipt from public.acquisition_commands
    where org_id=v_org and operation='record_call_start' and context_key_hash=v_token;
  if found then
    if v_receipt.request_hash is distinct from v_hash then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='MLS01'; end if;
    return jsonb_set(v_receipt.result,'{duplicate}','true'::jsonb);
  end if;
  select * into v_property from public.properties where id=v_property_id and org_id=v_org for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select * into v_queue from public.acquisition_queue_states where property_id=v_property_id and org_id=v_org for update;
  select * into v_episode from public.acquisition_assignment_episodes where id=v_episode_id and property_id=v_property_id and org_id=v_org for update;
  if v_episode_id is not null and not found then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  insert into public.acquisition_commands(id,org_id,actor_kind,operation,idempotency_key,request_hash,context_key_hash,result)
    values(v_command_id,v_org,'service','record_call_start',extensions.gen_random_uuid(),v_hash,v_token,'{}');
  insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,
    occurred_at,provider_attempt_key,idempotency_key,command_id)
    values(v_org,v_property_id,v_episode_id,v_actor,'call','sandra',v_at,v_token,extensions.gen_random_uuid(),v_command_id)
    returning * into v_attempt;
  -- Historical delivery may stop the original clock, never the new owner's clock.
  if v_episode.eligible and v_episode.assignee_user_id=v_actor and v_at >= v_episode.assigned_at
    and (v_episode.ended_at is null or v_at < v_episode.ended_at) then
    update public.acquisition_assignment_episodes set first_call_started_at=v_at,first_call_actor_user_id=v_actor,first_call_provider_key=v_token
      where id=v_episode_id and (first_call_started_at is null or first_call_started_at>v_at);
  end if;
  if v_episode_id is not null and v_episode.ended_at is null and v_episode.assignee_user_id=v_property.assigned_user_id
    and v_at >= coalesce(v_episode.assigned_at,v_episode.initialized_at)
    and v_queue.archived_at is null and v_property.deleted_at is null and not coalesce(v_property.is_dnc_locked,false)
    and v_property.status::text not in ('closed','dead','dnc')
    and exists(select 1 from public.acquisition_org_settings where org_id=v_org and my_leads_enabled) then
    if v_queue.property_id is null then
      insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,version)
        values(v_property_id,v_org,'contacted',v_at,1) returning * into v_queue;
    end if;
    if v_property.status::text in ('prospect','new_lead') then
      update public.properties set status='contacted' where id=v_property_id and org_id=v_org;
    end if;
  end if;
  v_result := jsonb_build_object('ok',true,'duplicate',false,'propertyId',v_property_id,'attemptId',v_attempt.id,
    'assignmentEpisodeId',v_episode_id,'queueVersion',coalesce(v_queue.version,0),'stage',v_queue.stage,'archived',v_queue.archived_at is not null,
    'jitterCallId',p_event->>'jitterCallId','sellerProviderCallId',p_event->>'sellerProviderCallId');
  update public.acquisition_commands set result=v_result where id=v_command_id;
  return v_result;
end;
$function$;

-- fn_log_acquisition_attempt_without_sms_obligation(jsonb) (4 raise sites)
CREATE OR REPLACE FUNCTION public.fn_log_acquisition_attempt_without_sms_obligation(p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid:=auth.uid();
  v_property_id uuid:=(p_input->>'propertyId')::uuid;
  v_key uuid:=(p_input->>'idempotencyKey')::uuid;
  v_expected_episode uuid:=(p_input->>'expectedEpisodeId')::uuid;
  v_version bigint:=(p_input->>'expectedQueueVersion')::bigint;
  v_at timestamptz:=(p_input->>'occurredAt')::timestamptz;
  v_source text:=p_input->>'source';
  v_kind text:=p_input->>'kind';
  v_outcome text:=p_input->>'outcome';
  v_org uuid;v_owner boolean;v_hash text;v_result jsonb;v_attempt_id uuid;
  v_property public.properties%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_receipt public.acquisition_commands%rowtype;
  v_command uuid:=extensions.gen_random_uuid();
begin
  if v_actor is null or v_property_id is null or v_key is null or v_version is null or v_version<0
    or v_at is null or not isfinite(v_at) or v_at>statement_timestamp()
    or (v_outcome in ('reached','no_answer','wrong_number')) is not true
    or ((v_source='dialpad' and v_kind='call') or (v_source='manual' and v_kind='outreach')) is not true then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select org_id into v_org from public.properties where id=v_property_id;
  select m.role='owner' into v_owner from public.memberships m where m.org_id=v_org and m.user_id=v_actor
    and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if nullif(btrim(p_input->>'recordingUrl'),'') is not null and
    (length(p_input->>'recordingUrl')>4096 or (p_input->>'recordingUrl') !~* '^https?://[^[:space:]]+$') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  v_hash:=public.my_leads_command_hash('log_acquisition_attempt',v_org,v_actor,p_input);
  perform pg_advisory_xact_lock(hashtextextended(format('my-leads:%s:%s:%s',v_org,'log_acquisition_attempt',v_key),0));
  select * into v_receipt from public.acquisition_commands where org_id=v_org and operation='log_acquisition_attempt' and idempotency_key=v_key;
  if found then
    if v_receipt.actor_user_id is distinct from v_actor or v_receipt.request_hash is distinct from v_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode='MLS01';
    end if;
    return jsonb_set(v_receipt.result,'{duplicate}','true'::jsonb);
  end if;
  if not exists(select 1 from public.acquisition_org_settings where org_id=v_org and my_leads_enabled) then
    raise exception 'FEATURE_DISABLED' using errcode='42501';
  end if;
  select * into v_property from public.properties where id=v_property_id and org_id=v_org for update;
  if not v_owner and v_property.assigned_user_id is distinct from v_actor then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_property.deleted_at is not null or v_property.is_dnc_locked or v_property.status='dnc' then
    raise exception 'DNC_LOCKED' using errcode='42501';
  end if;
  if v_property.status is distinct from p_input->>'expectedSharedStatus' then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select * into v_queue from public.acquisition_queue_states where property_id=v_property_id and org_id=v_org for update;
  select * into v_episode from public.acquisition_assignment_episodes where property_id=v_property_id and org_id=v_org and ended_at is null for update;
  if v_episode.id is distinct from v_expected_episode then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  if coalesce(v_queue.version,0)<>v_version or v_queue.archived_at is not null then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command,v_org,v_actor,'user','log_acquisition_attempt',v_key,v_hash,'{}');
  insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,outcome,occurred_at,note,recording_url,idempotency_key,command_id)
    values(v_org,v_property_id,v_episode.id,v_actor,v_kind,v_source,v_outcome,v_at,nullif(btrim(p_input->>'note'),''),nullif(btrim(p_input->>'recordingUrl'),''),v_key,v_command)
    returning id into v_attempt_id;
  if v_kind='call' and v_episode.eligible and v_episode.assignee_user_id=v_actor and v_at>=v_episode.assigned_at then
    update public.acquisition_assignment_episodes set first_call_started_at=v_at,first_call_actor_user_id=v_actor,
      first_call_provider_key='dialpad:'||v_attempt_id::text
      where id=v_episode.id and (first_call_started_at is null or first_call_started_at>v_at);
  end if;
  if v_queue.property_id is null then
    insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,version)
      values(v_property_id,v_org,'contacted',v_at,1) returning * into v_queue;
  else
    update public.acquisition_queue_states set version=version+1,updated_at=statement_timestamp()
      where property_id=v_property_id and org_id=v_org returning * into v_queue;
  end if;
  if v_property.status in ('new_lead','prospect') then update public.properties set status='contacted' where id=v_property_id; end if;
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',v_property_id,'attemptId',v_attempt_id,
    'assignmentEpisodeId',v_episode.id,'queueVersion',v_queue.version,'stage',v_queue.stage,'archived',false);
  update public.acquisition_commands set result=v_result where id=v_command;
  return v_result;
end;
$function$;

-- my_leads_workflow_replay(uuid,text,uuid,uuid,text) (1 raise sites)
CREATE OR REPLACE FUNCTION public.my_leads_workflow_replay(p_org_id uuid, p_operation text, p_idempotency_key uuid, p_actor uuid, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'MLS01';
  end if;
  return jsonb_set(v_existing.result, '{duplicate}', 'true'::jsonb, true);
end;
$function$;

-- fn_ready_acquisition_offer(uuid,uuid,uuid,bigint,text,uuid,text,text,text) (6 raise sites)
CREATE OR REPLACE FUNCTION public.fn_ready_acquisition_offer(p_org_id uuid, p_property_id uuid, p_expected_episode_id uuid, p_expected_queue_version bigint, p_expected_shared_status text, p_idempotency_key uuid, p_motivation_kind text, p_motivation_text text, p_temperature text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;
  select m.role into v_role
  from public.memberships m
  where m.org_id = p_org_id and m.user_id = v_actor
    and m.access_status = 'active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_role <> 'owner' and v_property.assigned_user_id is distinct from v_actor then
    raise exception 'STALE_ASSIGNMENT' using errcode = 'MLS01';
  end if;
  if v_property.status in ('offer_sent', 'offer_declined', 'under_contract', 'closed', 'dead') then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;

  select * into v_queue
  from public.acquisition_queue_states q
  where q.org_id = p_org_id and q.property_id = p_property_id
  for update;
  v_queue_exists := found;
  v_version := coalesce(v_queue.version, 0);
  if v_version <> p_expected_queue_version then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;
  v_stage := coalesce(v_queue.stage, 'not_contacted');
  if v_stage in ('offer_sent', 'under_contract') or v_queue.archived_at is not null then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;
  select * into v_episode
  from public.acquisition_assignment_episodes e
  where e.org_id = p_org_id and e.property_id = p_property_id and e.ended_at is null
  for update;
  v_episode_exists := found;
  if not v_episode_exists or v_episode.id is distinct from p_expected_episode_id then
    raise exception 'STALE_ASSIGNMENT' using errcode = 'MLS01';
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
$function$;

-- fn_log_acquisition_offer(uuid,uuid,uuid,bigint,text,uuid,bigint,text,timestamp with time zone,timestamp with time zone,text,text,text) (8 raise sites)
CREATE OR REPLACE FUNCTION public.fn_log_acquisition_offer(p_org_id uuid, p_property_id uuid, p_expected_episode_id uuid, p_expected_queue_version bigint, p_expected_shared_status text, p_idempotency_key uuid, p_amount_cents bigint, p_sent_via text, p_sent_at timestamp with time zone, p_follow_up_at timestamp with time zone, p_motivation_kind text DEFAULT NULL::text, p_motivation_text text DEFAULT NULL::text, p_temperature text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;
  select m.role into v_role from public.memberships m
  where m.org_id = p_org_id and m.user_id = v_actor and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_role <> 'owner' and v_property.assigned_user_id is distinct from v_actor then
    raise exception 'STALE_ASSIGNMENT' using errcode = 'MLS01';
  end if;
  if v_property.status in ('offer_declined', 'under_contract', 'closed', 'dead') then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;

  select * into v_queue from public.acquisition_queue_states q
  where q.org_id = p_org_id and q.property_id = p_property_id for update;
  v_queue_exists := found;
  v_version := coalesce(v_queue.version, 0);
  if v_version <> p_expected_queue_version then raise exception 'STALE_STATE' using errcode = 'MLS01'; end if;
  if v_queue.archived_at is not null or v_queue.stage = 'under_contract' then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;
  select * into v_episode from public.acquisition_assignment_episodes e
  where e.org_id = p_org_id and e.property_id = p_property_id and e.ended_at is null for update;
  v_episode_exists := found;
  if not v_episode_exists or v_episode.id is distinct from p_expected_episode_id then
    raise exception 'STALE_ASSIGNMENT' using errcode = 'MLS01';
  end if;
  select * into v_pending from public.acquisition_offers o
  where o.org_id = p_org_id and o.property_id = p_property_id and o.outcome = 'pending'
  for update;
  if found then raise exception 'PENDING_OFFER_EXISTS' using errcode = 'MLS01'; end if;

  if v_queue.motivation_recorded then
    if p_motivation_kind is not null and (
      v_queue.motivation_kind is distinct from p_motivation_kind or
      v_queue.motivation_text is distinct from nullif(btrim(p_motivation_text), '')
    ) then
      raise exception 'STALE_STATE' using errcode = 'MLS01';
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
$function$;

-- fn_record_acquisition_contract(uuid,uuid,uuid,bigint,text,uuid,timestamp with time zone,uuid) (7 raise sites)
CREATE OR REPLACE FUNCTION public.fn_record_acquisition_contract(p_org_id uuid, p_property_id uuid, p_expected_episode_id uuid, p_expected_queue_version bigint, p_expected_shared_status text, p_idempotency_key uuid, p_signed_at timestamp with time zone, p_offer_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if v_property.status is distinct from p_expected_shared_status then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select m.role into v_role from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor
    and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_role<>'owner' and v_property.assigned_user_id is distinct from v_actor then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  if v_property.status in ('offer_declined','closed','dead','under_contract') then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select * into v_queue from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id for update;
  v_queue_exists := found;
  if not v_queue_exists and p_expected_queue_version <> 0 then
    raise exception 'STALE_STATE' using errcode='MLS01';
  end if;
  v_version := coalesce(v_queue.version,0);
  if v_version<>p_expected_queue_version or v_queue.archived_at is not null or v_queue.stage='under_contract' then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.property_id=p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  if p_offer_id is not null then
    select * into v_offer from public.acquisition_offers o where o.id=p_offer_id and o.org_id=p_org_id and o.property_id=p_property_id for update;
    if not found or v_offer.assignment_episode_id is distinct from v_episode.id or v_offer.outcome<>'pending' then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
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
$function$;

-- fn_decline_acquisition_offer(uuid,uuid,uuid,bigint,text,uuid,uuid,timestamp with time zone) (8 raise sites)
CREATE OR REPLACE FUNCTION public.fn_decline_acquisition_offer(p_org_id uuid, p_property_id uuid, p_expected_episode_id uuid, p_expected_queue_version bigint, p_expected_shared_status text, p_idempotency_key uuid, p_offer_id uuid, p_occurred_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if v_property.status is distinct from p_expected_shared_status then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select m.role into v_role from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor and m.access_status='active'
    and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_role<>'owner' and v_property.assigned_user_id is distinct from v_actor then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  if v_property.status in ('closed','dead','under_contract','offer_declined') then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select * into v_queue from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id for update;
  if not found then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  v_version:=coalesce(v_queue.version,0);
  if v_version<>p_expected_queue_version or v_queue.archived_at is not null then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.property_id=p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  select * into v_offer from public.acquisition_offers o where o.id=p_offer_id and o.org_id=p_org_id and o.property_id=p_property_id for update;
  if not found or v_offer.assignment_episode_id is distinct from v_episode.id or v_offer.outcome<>'pending' then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  if p_occurred_at < v_offer.sent_at then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
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
  if not found then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  perform set_config('my_leads.handoff_property_id','',true);
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',p_property_id,'queueVersion',v_version+1,'stage',v_queue.stage,'archived',true,'assignmentEpisodeId',v_episode.id);
  update public.acquisition_commands set result=v_result where id=v_command_id and org_id=p_org_id;
  perform public.my_leads_workflow_append_event(p_org_id,p_property_id,v_actor,v_command_id,'decline_acquisition_offer',jsonb_build_object('status','offer_declined','disposition','needs_sequence','recipientUserId',v_settings.needs_sequence_owner_id));
  return v_result;
end;
$function$;

-- fn_handoff_acquisition_lead(uuid,uuid,uuid,bigint,text,uuid,text,uuid) (7 raise sites)
CREATE OR REPLACE FUNCTION public.fn_handoff_acquisition_lead(p_org_id uuid, p_property_id uuid, p_expected_episode_id uuid, p_expected_queue_version bigint, p_expected_shared_status text, p_idempotency_key uuid, p_reason text, p_recipient_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_queue_exists boolean;
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
  if v_property.status is distinct from p_expected_shared_status then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select m.role into v_role from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor and m.access_status='active'
    and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_role<>'owner' and v_property.assigned_user_id is distinct from v_actor then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  if v_property.status in ('closed','dead','under_contract') then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select * into v_queue from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id for update;
  v_queue_exists := found;
  v_version:=coalesce(v_queue.version,0);
  if not v_queue_exists and p_expected_queue_version <> 0 then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  if v_queue_exists and (v_version<>p_expected_queue_version or v_queue.archived_at is not null) then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.property_id=p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  select * into v_settings from public.acquisition_org_settings s where s.org_id=p_org_id;
  if not found or v_settings.needs_sequence_owner_id is distinct from p_recipient_user_id or not exists(
    select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_recipient_user_id and m.access_status='active'
      and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
  ) then raise exception 'RECIPIENT_UNAVAILABLE' using errcode='22023'; end if;
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command_id,p_org_id,v_actor,'user','handoff_acquisition_lead',p_idempotency_key,v_hash,'{}');
  if v_queue_exists then
    update public.acquisition_queue_states q set archived_at=statement_timestamp(),archived_by=v_actor,archive_reason='needs_sequence_handoff',version=q.version+1,updated_at=statement_timestamp()
      where q.org_id=p_org_id and q.property_id=p_property_id;
  else
    -- Not contacted is implicit in the read model, but the assignment observer
    -- needs an archived sentinel to prove that this handoff is intentional.
    insert into public.acquisition_queue_states (
      property_id, org_id, stage, stage_entered_at, archived_at, archived_by,
      archive_reason, version
    ) values (
      p_property_id, p_org_id, 'contacted', coalesce(v_episode.assigned_at, statement_timestamp()),
      statement_timestamp(), v_actor, 'needs_sequence_handoff', 1
    );
  end if;
  perform set_config('my_leads.handoff_property_id',format('%s:%s',p_property_id,v_command_id),true);
  update public.properties set outreach_dispo='needs_sequence',assigned_user_id=p_recipient_user_id,updated_at=statement_timestamp()
    where id=p_property_id and org_id=p_org_id and assigned_user_id is not distinct from v_property.assigned_user_id;
  if not found then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  perform set_config('my_leads.handoff_property_id','',true);
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',p_property_id,'queueVersion',v_version+1,'stage',coalesce(v_queue.stage,'not_contacted'),'archived',true,'assignmentEpisodeId',v_episode.id);
  update public.acquisition_commands set result=v_result where id=v_command_id and org_id=p_org_id;
  perform public.my_leads_workflow_append_event(p_org_id,p_property_id,v_actor,v_command_id,'handoff_acquisition_lead',jsonb_build_object('disposition','needs_sequence','reason',p_reason,'recipientUserId',p_recipient_user_id));
  return v_result;
end;
$function$;

-- fn_archive_acquisition_contract(uuid,uuid,uuid,bigint,text,uuid) (5 raise sites)
CREATE OR REPLACE FUNCTION public.fn_archive_acquisition_contract(p_org_id uuid, p_property_id uuid, p_expected_episode_id uuid, p_expected_queue_version bigint, p_expected_shared_status text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if v_property.status is distinct from p_expected_shared_status or v_property.status<>'under_contract' then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select m.role into v_role from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor and m.access_status='active'
    and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_role<>'owner' and v_property.assigned_user_id is distinct from v_actor then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  select * into v_queue from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id for update;
  if not found or v_queue.stage<>'under_contract' or v_queue.archived_at is not null then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  v_version:=coalesce(v_queue.version,0);
  if v_version<>p_expected_queue_version then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.property_id=p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  update public.acquisition_queue_states q set archived_at=statement_timestamp(),archived_by=v_actor,archive_reason='under_contract_archived',version=q.version+1,updated_at=statement_timestamp()
    where q.org_id=p_org_id and q.property_id=p_property_id;
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',p_property_id,'queueVersion',v_version+1,'stage','under_contract','archived',true,'assignmentEpisodeId',v_episode.id);
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command_id,p_org_id,v_actor,'user','archive_acquisition_contract',p_idempotency_key,v_hash,v_result);
  perform public.my_leads_workflow_append_event(p_org_id,p_property_id,v_actor,v_command_id,'archive_acquisition_contract',jsonb_build_object('stage','under_contract','archived',true));
  return v_result;
end;
$function$;

-- fn_finalize_acquisition_attempt_without_sms_obligation(jsonb) (2 raise sites)
CREATE OR REPLACE FUNCTION public.fn_finalize_acquisition_attempt_without_sms_obligation(p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid:=(p_input->>'orgId')::uuid;
  v_actor uuid:=auth.uid();
  v_key uuid:=(p_input->>'idempotencyKey')::uuid;
  v_activity uuid:=(p_input->>'callActivityId')::uuid;
  v_attempt public.acquisition_attempts%rowtype;
  v_receipt public.acquisition_commands%rowtype;
  v_hash text;
  v_result jsonb;
begin
  if v_actor is null or not exists(select 1 from public.memberships m where m.org_id=v_org and m.user_id=v_actor
    and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if v_key is null or v_activity is null or (p_input->>'outcome') is null or (p_input->>'outcome') not in ('reached','no_answer','wrong_number') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if nullif(btrim(p_input->>'recordingUrl'),'') is not null and
    (length(p_input->>'recordingUrl')>4096 or (p_input->>'recordingUrl') !~* '^https?://[^[:space:]]+$') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  v_hash:=public.my_leads_command_hash('finalize_acquisition_attempt',v_org,v_actor,p_input);
  perform pg_advisory_xact_lock(hashtextextended(v_org::text||':finalize-command:'||v_key::text,0));
  select * into v_receipt from public.acquisition_commands where org_id=v_org and operation='finalize_acquisition_attempt' and idempotency_key=v_key;
  if found then
    if v_receipt.request_hash is distinct from v_hash then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='MLS01'; end if;
    return jsonb_set(v_receipt.result,'{duplicate}','true');
  end if;
  select * into v_attempt from public.acquisition_attempts where org_id=v_org and call_activity_id=v_activity
    and property_id=(p_input->>'propertyId')::uuid
    and (source='sandra' or (source='dialpad' and provider_attempt_key like 'dialpad-cti:%'))
    and actor_user_id=v_actor for update;
  if not found then raise exception 'PROVIDER_EVIDENCE_PENDING' using errcode='42501'; end if;
  if v_attempt.outcome is distinct from p_input->>'outcome' and exists(
    select 1 from public.acquisition_commands r where r.org_id=v_org
      and r.operation='finalize_acquisition_attempt' and r.result->>'attemptId'=v_attempt.id::text
  ) then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  update public.acquisition_attempts set outcome=p_input->>'outcome',note=coalesce(nullif(btrim(p_input->>'note'),''),note),
    recording_url=coalesce(nullif(btrim(p_input->>'recordingUrl'),''),recording_url) where id=v_attempt.id;
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',v_attempt.property_id,'attemptId',v_attempt.id);
  insert into public.acquisition_commands(org_id,actor_kind,actor_user_id,operation,idempotency_key,request_hash,result)
    values(v_org,'user',v_actor,'finalize_acquisition_attempt',v_key,v_hash,v_result);
  return v_result;
end;
$function$;

-- fn_preview_acquisition_launch(uuid,uuid) (1 raise sites)
CREATE OR REPLACE FUNCTION public.fn_preview_acquisition_launch(p_org_id uuid, p_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := public.my_leads_launch_require_owner(p_org_id);
  v_settings public.acquisition_org_settings%rowtype;
  v_member public.memberships%rowtype;
  v_rows jsonb;
  v_fingerprint text;
  v_cutoff timestamptz := statement_timestamp();
  v_cohort_id uuid := extensions.gen_random_uuid();
  v_total bigint;
  v_closed_dead bigint;
  v_dnc bigint;
  v_offer_declined bigint;
  v_archived bigint;
  v_missing_episode bigint;
begin
  select * into v_settings from public.acquisition_org_settings s
  where s.org_id = p_org_id for share;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_settings.my_leads_enabled or v_settings.active_launch_cohort_id is not null then
    raise exception 'LAUNCH_ALREADY_APPLIED' using errcode = 'MLS01';
  end if;
  select * into v_member from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_member_id for share;
  if not found or v_member.access_status <> 'active' or v_member.deletion_prepared_at is not null
     or (v_member.access_expires_at is not null and v_member.access_expires_at <= v_cutoff)
     or not v_member.acquisitions_enabled then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;
  if v_settings.needs_sequence_owner_id is null or not exists (
    select 1 from public.memberships r
    where r.org_id = p_org_id and r.user_id = v_settings.needs_sequence_owner_id
      and r.access_status = 'active' and r.deletion_prepared_at is null
      and (r.access_expires_at is null or r.access_expires_at > v_cutoff)
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.property_id), '[]'::jsonb)
    into v_rows
  from public.my_leads_launch_candidate_rows(p_org_id, p_member_id) r;
  v_fingerprint := public.my_leads_launch_fingerprint(
    p_org_id, p_member_id, v_settings.settings_revision
  );

  select count(*) into v_total from public.properties p
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id;
  select count(*) into v_closed_dead from public.properties p
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id
    and p.status in ('closed', 'dead');
  select count(*) into v_dnc from public.properties p
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id
    and (p.is_dnc_locked or p.outreach_dispo = 'dnc');
  select count(*) into v_offer_declined from public.properties p
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id
    and p.status = 'offer_declined';
  select count(*) into v_archived from public.properties p
  join public.acquisition_queue_states q on q.org_id = p.org_id and q.property_id = p.id
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id and q.archived_at is not null;
  select count(*) into v_missing_episode from public.properties p
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id
    and p.deleted_at is null and not coalesce(p.is_dnc_locked, false)
    and p.status in ('prospect', 'new_lead', 'contacted', 'interested', 'offer_sent', 'under_contract')
    and not exists (
      select 1 from public.acquisition_assignment_episodes e
      where e.org_id = p.org_id and e.property_id = p.id and e.ended_at is null
    );

  return jsonb_build_object(
    'ok', true, 'cohortId', v_cohort_id, 'orgId', p_org_id, 'memberId', p_member_id,
    'settingsRevision', v_settings.settings_revision, 'previewCutoffAt', v_cutoff,
    'previewCount', jsonb_array_length(v_rows), 'fingerprint', v_fingerprint,
    'rows', v_rows,
    'excluded', jsonb_build_object(
      'assignedTotal', v_total, 'closedOrDead', v_closed_dead, 'dnc', v_dnc,
      'offerDeclined', v_offer_declined, 'alreadyArchived', v_archived,
      'missingEpisode', v_missing_episode
    )
  );
end;
$function$;

-- fn_apply_acquisition_launch(uuid,uuid,uuid,text,bigint,uuid) (7 raise sites)
CREATE OR REPLACE FUNCTION public.fn_apply_acquisition_launch(p_org_id uuid, p_member_id uuid, p_cohort_id uuid, p_preview_fingerprint text, p_expected_settings_revision bigint, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := public.my_leads_launch_require_owner(p_org_id);
  v_settings public.acquisition_org_settings%rowtype;
  v_member public.memberships%rowtype;
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_current_fingerprint text;
  v_rows jsonb;
  v_current_rows jsonb;
  v_count integer;
  v_cutover timestamptz := statement_timestamp();
  v_item record;
  v_property public.properties%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_episode_exists boolean;
  v_prior_queue public.acquisition_queue_states%rowtype;
  v_prior_queue_exists boolean;
  v_stage text;
  v_launch_episode_id uuid;
  v_applied_queue_version bigint;
begin
  if p_member_id is null or p_cohort_id is null or p_preview_fingerprint is null
     or p_expected_settings_revision is null or p_expected_settings_revision < 0
     or p_idempotency_key is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := public.my_leads_command_hash(
    'apply_acquisition_launch', p_org_id, v_actor,
    jsonb_build_object('memberId', p_member_id, 'cohortId', p_cohort_id,
      'fingerprint', p_preview_fingerprint, 'expectedSettingsRevision', p_expected_settings_revision)
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'apply_acquisition_launch', p_idempotency_key), 0
  ));
  v_replay := public.my_leads_workflow_replay(
    p_org_id, 'apply_acquisition_launch', p_idempotency_key, v_actor, v_hash
  );
  if v_replay is not null then return v_replay; end if;

  select * into v_settings from public.acquisition_org_settings s
  where s.org_id = p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_settings.my_leads_enabled or v_settings.active_launch_cohort_id is not null
     or v_settings.settings_revision <> p_expected_settings_revision then
    raise exception 'LAUNCH_INVALIDATED' using errcode = 'MLS01';
  end if;
  select * into v_member from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_member_id for update;
  if not found or v_member.access_status <> 'active' or v_member.deletion_prepared_at is not null
     or (v_member.access_expires_at is not null and v_member.access_expires_at <= v_cutover)
     or not v_member.acquisitions_enabled then
    raise exception 'LAUNCH_INVALIDATED' using errcode = 'MLS01';
  end if;
  if v_settings.needs_sequence_owner_id is null or not exists (
    select 1 from public.memberships r
    where r.org_id = p_org_id and r.user_id = v_settings.needs_sequence_owner_id
      and r.access_status = 'active' and r.deletion_prepared_at is null
      and (r.access_expires_at is null or r.access_expires_at > v_cutover)
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;

  -- Capture the candidate set once. Every later lock, revalidation and
  -- write uses this same bounded set; a property assigned after this point
  -- remains outside the admitted preview.
  select coalesce(jsonb_agg(to_jsonb(r) order by r.property_id), '[]'::jsonb)
    into v_rows
  from public.my_leads_launch_candidate_rows(p_org_id, p_member_id) r;
  v_count := jsonb_array_length(v_rows);
  v_current_fingerprint := public.my_leads_launch_fingerprint_rows(
    p_org_id, p_member_id, v_settings.settings_revision, v_rows
  );
  if v_current_fingerprint is distinct from p_preview_fingerprint then
    raise exception 'LAUNCH_INVALIDATED' using errcode = 'MLS01';
  end if;

  -- Lock the captured preview set in deterministic property order, then
  -- re-read only those property IDs. This detects changes to declared rows
  -- without admitting a newly assigned property into the cohort.
  for v_item in
    select * from jsonb_to_recordset(v_rows) as captured(
      property_id uuid,
      expected_episode_id uuid,
      expected_assigned_user_id uuid,
      expected_assigned_at timestamptz,
      expected_episode_initialized_at timestamptz,
      expected_member_revision bigint,
      expected_shared_status text,
      expected_queue_version bigint,
      expected_queue_stage text,
      expected_is_dnc_locked boolean,
      expected_deleted_at timestamptz,
      expected_settings_revision bigint
    )
    order by property_id
  loop
    select * into v_property from public.properties p
    where p.id = v_item.property_id and p.org_id = p_org_id for update;
    if not found then raise exception 'LAUNCH_INVALIDATED' using errcode = 'MLS01'; end if;
    select * into v_episode from public.acquisition_assignment_episodes e
    where e.org_id = p_org_id and e.property_id = v_item.property_id and e.ended_at is null
    for update;
    v_episode_exists := found;
    select * into v_prior_queue from public.acquisition_queue_states q
    where q.org_id = p_org_id and q.property_id = v_item.property_id for update;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.property_id), '[]'::jsonb)
    into v_current_rows
  from public.my_leads_launch_candidate_rows(p_org_id, p_member_id) r
  join jsonb_to_recordset(v_rows) as captured(property_id uuid)
    on captured.property_id = r.property_id;
  v_current_fingerprint := public.my_leads_launch_fingerprint_rows(
    p_org_id, p_member_id, v_settings.settings_revision, v_current_rows
  );
  if v_current_fingerprint is distinct from p_preview_fingerprint then
    raise exception 'LAUNCH_INVALIDATED' using errcode = 'MLS01';
  end if;

  insert into public.acquisition_commands (
    id, org_id, actor_user_id, actor_kind, operation, idempotency_key, request_hash, result
  ) values (
    v_command_id, p_org_id, v_actor, 'user', 'apply_acquisition_launch',
    p_idempotency_key, v_hash, '{}'::jsonb
  );
  if v_count = 0 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  insert into public.acquisition_launch_cohorts (
    id, org_id, member_id, status, preview_count, preview_fingerprint,
    preview_cutoff_at, started_at, created_by
  )
  values (
    p_cohort_id, p_org_id, p_member_id, 'running', v_count,
    p_preview_fingerprint, v_cutover, v_cutover, v_actor
  );

  for v_item in
    select * from jsonb_to_recordset(v_rows) as captured(
      property_id uuid,
      expected_episode_id uuid,
      expected_assigned_user_id uuid,
      expected_assigned_at timestamptz,
      expected_episode_initialized_at timestamptz,
      expected_member_revision bigint,
      expected_shared_status text,
      expected_queue_version bigint,
      expected_queue_stage text,
      expected_is_dnc_locked boolean,
      expected_deleted_at timestamptz,
      expected_settings_revision bigint
    )
    order by property_id
  loop
    select * into v_property from public.properties p
    where p.id = v_item.property_id and p.org_id = p_org_id for update;
    if not found then
      raise exception 'LAUNCH_INVALIDATED' using errcode = 'MLS01';
    end if;
    select * into v_episode from public.acquisition_assignment_episodes e
    where e.org_id = p_org_id and e.property_id = v_item.property_id and e.ended_at is null
    for update;
    v_episode_exists := found;
    select * into v_prior_queue from public.acquisition_queue_states q
    where q.org_id = p_org_id and q.property_id = v_item.property_id for update;
    v_prior_queue_exists := found;

    insert into public.acquisition_launch_cohort_items (
      cohort_id, org_id, property_id, member_id, expected_episode_id,
      expected_assigned_user_id, expected_assigned_at, expected_episode_initialized_at,
      expected_member_revision, expected_shared_status, expected_queue_version,
      expected_queue_stage, expected_is_dnc_locked, expected_deleted_at,
      expected_settings_revision, prior_episode_id, prior_episode_eligible,
      prior_episode_assigned_at, prior_episode_initialized_at, prior_queue_exists,
      prior_queue_stage, prior_queue_stage_entered_at, prior_queue_motivation_recorded,
      prior_queue_motivation_kind, prior_queue_motivation_text,
      prior_queue_motivation_recorded_at, prior_queue_motivation_recorded_by,
      prior_queue_archived_at, prior_queue_archived_by, prior_queue_archive_reason,
      prior_queue_version, prior_queue_launch_cohort_id,
      prior_queue_launch_previous_shared_status, prior_queue_signed_at,
      prior_queue_signed_by
    ) values (
      p_cohort_id, p_org_id, v_item.property_id, p_member_id, v_item.expected_episode_id,
      v_item.expected_assigned_user_id, v_item.expected_assigned_at,
      v_item.expected_episode_initialized_at, v_item.expected_member_revision,
      v_item.expected_shared_status, v_item.expected_queue_version, v_item.expected_queue_stage,
      v_item.expected_is_dnc_locked, v_item.expected_deleted_at,
      v_item.expected_settings_revision, v_episode.id,
      case when v_episode_exists then v_episode.eligible end,
      case when v_episode_exists then v_episode.assigned_at end,
      case when v_episode_exists then v_episode.initialized_at end,
      v_prior_queue_exists,
      case when v_prior_queue_exists then v_prior_queue.stage end,
      case when v_prior_queue_exists then v_prior_queue.stage_entered_at end,
      case when v_prior_queue_exists then v_prior_queue.motivation_recorded end,
      case when v_prior_queue_exists then v_prior_queue.motivation_kind end,
      case when v_prior_queue_exists then v_prior_queue.motivation_text end,
      case when v_prior_queue_exists then v_prior_queue.motivation_recorded_at end,
      case when v_prior_queue_exists then v_prior_queue.motivation_recorded_by end,
      case when v_prior_queue_exists then v_prior_queue.archived_at end,
      case when v_prior_queue_exists then v_prior_queue.archived_by end,
      case when v_prior_queue_exists then v_prior_queue.archive_reason end,
      case when v_prior_queue_exists then v_prior_queue.version end,
      case when v_prior_queue_exists then v_prior_queue.launch_cohort_id end,
      case when v_prior_queue_exists then v_prior_queue.launch_previous_shared_status end,
      case when v_prior_queue_exists then v_prior_queue.signed_at end,
      case when v_prior_queue_exists then v_prior_queue.signed_by end
    );

    if v_episode_exists then
      update public.acquisition_assignment_episodes
      set ended_at = v_cutover
      where id = v_episode.id and org_id = p_org_id;
    end if;
    insert into public.acquisition_assignment_episodes (
      org_id, property_id, assignee_user_id, episode_kind, eligible,
      assigned_at, initialized_at, launch_cohort_id
    ) values (
      p_org_id, v_item.property_id, p_member_id, 'launch', false,
      null, v_cutover, p_cohort_id
    ) returning id into v_launch_episode_id;

    v_stage := coalesce(v_item.expected_queue_stage,
      case v_item.expected_shared_status
        when 'prospect' then 'contacted'
        when 'new_lead' then 'contacted'
        when 'contacted' then 'contacted'
        when 'interested' then 'needs_offer'
        when 'offer_sent' then 'offer_sent'
        when 'under_contract' then 'under_contract'
        else null
      end);
    if v_stage is null then
      raise exception 'LAUNCH_INVALIDATED' using errcode = 'MLS01';
    end if;
    if v_prior_queue_exists then
      update public.acquisition_queue_states q
      set launch_cohort_id = p_cohort_id,
          launch_previous_shared_status = v_item.expected_shared_status,
          version = q.version + 1,
          updated_at = v_cutover
      where q.org_id = p_org_id and q.property_id = v_item.property_id;
      v_applied_queue_version := v_item.expected_queue_version + 1;
    else
      insert into public.acquisition_queue_states (
        property_id, org_id, stage, stage_entered_at, version,
        launch_cohort_id, launch_previous_shared_status
      ) values (
        v_item.property_id, p_org_id, v_stage, v_cutover, 0,
        p_cohort_id, v_item.expected_shared_status
      );
      v_applied_queue_version := 0;
    end if;
    update public.acquisition_launch_cohort_items i
    set launch_episode_id = v_launch_episode_id
    where i.cohort_id = p_cohort_id and i.property_id = v_item.property_id;
  end loop;

  update public.acquisition_org_settings s
  set active_launch_cohort_id = p_cohort_id,
      launch_cutover_at = v_cutover,
      settings_revision = s.settings_revision + 1,
      updated_at = v_cutover
  where s.org_id = p_org_id;
  update public.acquisition_launch_cohorts
  set status = 'complete', completed_at = v_cutover
  where id = p_cohort_id and org_id = p_org_id;
  v_result := jsonb_build_object(
    'ok', true, 'duplicate', false, 'cohortId', p_cohort_id,
    'memberId', p_member_id, 'count', v_count, 'fingerprint', p_preview_fingerprint,
    'settingsRevision', p_expected_settings_revision + 1
  );
  update public.acquisition_commands set result = v_result
  where id = v_command_id and org_id = p_org_id;
  return v_result;
end;
$function$;

-- fn_rollback_acquisition_launch(uuid,uuid,uuid) (7 raise sites)
CREATE OR REPLACE FUNCTION public.fn_rollback_acquisition_launch(p_org_id uuid, p_cohort_id uuid, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := public.my_leads_launch_require_owner(p_org_id);
  v_settings public.acquisition_org_settings%rowtype;
  v_cohort public.acquisition_launch_cohorts%rowtype;
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_item record;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_queue_exists boolean;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_attempts bigint;
  v_offers bigint;
  v_expected_stage text;
  v_count integer := 0;
  v_now timestamptz := statement_timestamp();
begin
  if p_cohort_id is null or p_idempotency_key is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := public.my_leads_command_hash(
    'rollback_acquisition_launch', p_org_id, v_actor,
    jsonb_build_object('cohortId', p_cohort_id)
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'rollback_acquisition_launch', p_idempotency_key), 0
  ));
  v_replay := public.my_leads_workflow_replay(
    p_org_id, 'rollback_acquisition_launch', p_idempotency_key, v_actor, v_hash
  );
  if v_replay is not null then return v_replay; end if;
  select * into v_settings from public.acquisition_org_settings s
  where s.org_id = p_org_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v_cohort from public.acquisition_launch_cohorts c
  where c.id = p_cohort_id and c.org_id = p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_settings.my_leads_enabled then
    raise exception 'FEATURE_ENABLED' using errcode = 'MLS01';
  end if;
  if v_settings.active_launch_cohort_id is distinct from p_cohort_id
     or v_cohort.status not in ('complete', 'running') then
    if v_cohort.status = 'rolled_back' then
      raise exception 'STALE_STATE' using errcode = 'MLS01';
    end if;
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;

  for v_item in
    select * from public.acquisition_launch_cohort_items i
    where i.org_id = p_org_id and i.cohort_id = p_cohort_id
    order by property_id
  loop
    select * into v_property from public.properties p
    where p.id = v_item.property_id and p.org_id = p_org_id for update;
    if not found then
      raise exception 'ROLLBACK_BLOCKED' using errcode = 'MLS01';
    end if;
    select * into v_episode from public.acquisition_assignment_episodes e
    where e.org_id = p_org_id and e.property_id = v_item.property_id and e.ended_at is null
    for update;
    if not found or v_episode.id is distinct from v_item.launch_episode_id
       or v_episode.episode_kind <> 'launch' or v_episode.first_call_started_at is not null then
      raise exception 'ROLLBACK_BLOCKED' using errcode = 'MLS01';
    end if;
    select * into v_queue from public.acquisition_queue_states q
    where q.org_id = p_org_id and q.property_id = v_item.property_id for update;
    v_queue_exists := found;
    v_expected_stage := coalesce(v_item.expected_queue_stage,
      case v_item.expected_shared_status
        when 'prospect' then 'contacted'
        when 'new_lead' then 'contacted'
        when 'contacted' then 'contacted'
        when 'interested' then 'needs_offer'
        when 'offer_sent' then 'offer_sent'
        when 'under_contract' then 'under_contract'
        else null
      end);
    if v_property.assigned_user_id is distinct from v_item.expected_assigned_user_id
       or v_property.status is distinct from v_item.expected_shared_status
       or coalesce(v_property.is_dnc_locked, false) is distinct from v_item.expected_is_dnc_locked
       or v_property.deleted_at is distinct from v_item.expected_deleted_at
       or not v_queue_exists
       or v_queue.launch_cohort_id is distinct from p_cohort_id
       or v_queue.launch_previous_shared_status is distinct from v_item.expected_shared_status
       or v_queue.stage is distinct from v_expected_stage
       or v_queue.stage_entered_at is distinct from (case
         when v_item.prior_queue_exists then v_item.prior_queue_stage_entered_at
         else v_queue.stage_entered_at
       end)
       or v_queue.motivation_recorded is distinct from (case
         when v_item.prior_queue_exists then v_item.prior_queue_motivation_recorded
         else false
       end)
       or v_queue.motivation_kind is distinct from (case
         when v_item.prior_queue_exists then v_item.prior_queue_motivation_kind
         else null
       end)
       or v_queue.motivation_text is distinct from (case
         when v_item.prior_queue_exists then v_item.prior_queue_motivation_text
         else null
       end)
       or v_queue.archived_at is not null
       or v_queue.archived_by is not null
       or v_queue.archive_reason is not null
       or v_queue.version <> v_item.expected_queue_version +
         (case when v_item.prior_queue_exists then 1 else 0 end) then
      raise exception 'ROLLBACK_BLOCKED' using errcode = 'MLS01';
    end if;
    select count(*) into v_attempts from public.acquisition_attempts a
    where a.org_id = p_org_id and a.property_id = v_item.property_id
      and a.assignment_episode_id = v_item.launch_episode_id;
    select count(*) into v_offers from public.acquisition_offers o
    where o.org_id = p_org_id and o.property_id = v_item.property_id
      and o.assignment_episode_id = v_item.launch_episode_id;
    if v_attempts > 0 or v_offers > 0 then
      raise exception 'ROLLBACK_BLOCKED' using errcode = 'MLS01';
    end if;

    update public.acquisition_assignment_episodes
    set ended_at = v_now where id = v_item.launch_episode_id and org_id = p_org_id;
    if v_item.prior_episode_id is not null then
      update public.acquisition_assignment_episodes
      set ended_at = null where id = v_item.prior_episode_id and org_id = p_org_id;
    end if;
    if v_item.prior_queue_exists then
      update public.acquisition_queue_states q
      set stage = v_item.prior_queue_stage,
          stage_entered_at = v_item.prior_queue_stage_entered_at,
          motivation_recorded = v_item.prior_queue_motivation_recorded,
          motivation_kind = v_item.prior_queue_motivation_kind,
          motivation_text = v_item.prior_queue_motivation_text,
          motivation_recorded_at = v_item.prior_queue_motivation_recorded_at,
          motivation_recorded_by = v_item.prior_queue_motivation_recorded_by,
          archived_at = v_item.prior_queue_archived_at,
          archived_by = v_item.prior_queue_archived_by,
          archive_reason = v_item.prior_queue_archive_reason,
          version = v_item.prior_queue_version,
          launch_cohort_id = v_item.prior_queue_launch_cohort_id,
          launch_previous_shared_status = v_item.prior_queue_launch_previous_shared_status,
          signed_at = v_item.prior_queue_signed_at,
          signed_by = v_item.prior_queue_signed_by,
          updated_at = v_now
      where q.org_id = p_org_id and q.property_id = v_item.property_id;
    else
      delete from public.acquisition_queue_states q
      where q.org_id = p_org_id and q.property_id = v_item.property_id;
    end if;
    update public.acquisition_launch_cohort_items
    set rolled_back_at = v_now
    where cohort_id = p_cohort_id and property_id = v_item.property_id;
    v_count := v_count + 1;
  end loop;

  update public.acquisition_org_settings s
  set active_launch_cohort_id = null,
      launch_cutover_at = null,
      settings_revision = s.settings_revision + 1,
      updated_at = v_now
  where s.org_id = p_org_id;
  update public.acquisition_launch_cohorts
  set status = 'rolled_back', completed_at = coalesce(completed_at, v_now)
  where id = p_cohort_id and org_id = p_org_id;
  insert into public.acquisition_commands (
    id, org_id, actor_user_id, actor_kind, operation, idempotency_key, request_hash, result
  ) values (
    v_command_id, p_org_id, v_actor, 'user', 'rollback_acquisition_launch',
    p_idempotency_key, v_hash,
    jsonb_build_object('ok', true, 'duplicate', false, 'cohortId', p_cohort_id, 'count', v_count)
  );
  v_result := jsonb_build_object(
    'ok', true, 'duplicate', false, 'cohortId', p_cohort_id, 'count', v_count
  );
  update public.acquisition_commands set result = v_result
  where id = v_command_id and org_id = p_org_id;
  return v_result;
end;
$function$;

-- fn_handoff_acquisition_lead_to_drip(uuid,uuid,uuid,uuid,bigint,text,uuid) (6 raise sites)
CREATE OR REPLACE FUNCTION public.fn_handoff_acquisition_lead_to_drip(p_org_id uuid, p_member_id uuid, p_property_id uuid, p_expected_episode_id uuid, p_expected_queue_version bigint, p_expected_shared_status text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_queue_exists boolean;
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
begin
  if p_member_id is null or p_property_id is null or p_expected_episode_id is null
    or p_expected_queue_version is null or p_expected_queue_version < 0
    or p_expected_shared_status is null or p_idempotency_key is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if v_actor <> p_member_id and not exists (
    select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = v_actor
      and m.role = 'owner' and m.access_status = 'active'
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from public.acquisition_org_settings s
    where s.org_id = p_org_id and s.my_leads_enabled) or not exists (
    select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_member_id
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  v_hash := public.my_leads_command_hash('handoff_acquisition_lead_to_drip',p_org_id,v_actor,
    jsonb_build_object('memberId',p_member_id,'propertyId',p_property_id,
      'expectedEpisodeId',p_expected_episode_id,'expectedQueueVersion',p_expected_queue_version,
      'expectedSharedStatus',p_expected_shared_status));
  perform pg_advisory_xact_lock(hashtextextended(format('my-leads:%s:%s:%s',
    p_org_id,'handoff_acquisition_lead_to_drip',p_idempotency_key),0));
  v_replay := public.my_leads_workflow_replay(p_org_id,'handoff_acquisition_lead_to_drip',
    p_idempotency_key,v_actor,v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_property from public.properties p
    where p.org_id = p_org_id and p.id = p_property_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_property.assigned_user_id is distinct from p_member_id then
    raise exception 'STALE_ASSIGNMENT' using errcode = 'MLS01'; end if;
  if v_property.deleted_at is not null or v_property.is_dnc_locked
    or v_property.outreach_dispo in ('dnc','opted_out') then
    raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_property.status is distinct from p_expected_shared_status
    or v_property.status in ('closed','dead','dnc','under_contract') then
    raise exception 'STALE_STATE' using errcode = 'MLS01'; end if;
  select * into v_queue from public.acquisition_queue_states q
    where q.org_id = p_org_id and q.property_id = p_property_id for update;
  v_queue_exists := found;
  if coalesce(v_queue.version,0) is distinct from p_expected_queue_version
    or v_queue.archived_at is not null then
    raise exception 'STALE_STATE' using errcode = 'MLS01'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e
    where e.org_id = p_org_id and e.property_id = p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id
    or v_episode.assignee_user_id is distinct from p_member_id then
    raise exception 'STALE_ASSIGNMENT' using errcode = 'MLS01'; end if;

  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,
    idempotency_key,request_hash,result)
    values(v_command_id,p_org_id,v_actor,'user','handoff_acquisition_lead_to_drip',
      p_idempotency_key,v_hash,'{}');
  update public.properties set outreach_dispo = 'needs_sequence',follow_up_at = null,
    updated_at = statement_timestamp()
    where org_id = p_org_id and id = p_property_id and assigned_user_id = p_member_id;
  if not found then raise exception 'STALE_ASSIGNMENT' using errcode = 'MLS01'; end if;
  if v_queue_exists then
    update public.acquisition_queue_states q set version = q.version + 1,
      updated_at = statement_timestamp()
      where q.org_id = p_org_id and q.property_id = p_property_id and q.version = p_expected_queue_version;
    if not found then raise exception 'STALE_STATE' using errcode = 'MLS01'; end if;
  else
    insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,version)
      values(p_property_id,p_org_id,'contacted',statement_timestamp(),1);
  end if;
  v_result := jsonb_build_object('ok',true,'propertyId',p_property_id,
    'queueVersion',p_expected_queue_version + 1);
  update public.acquisition_commands set result = v_result
    where id = v_command_id and org_id = p_org_id;
  if v_property.outreach_dispo is distinct from 'needs_sequence' then
    insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,
      payload,source_type,source_id)
      values(p_org_id,p_property_id,'user',v_actor,'dispo_set',
        jsonb_build_object('from',v_property.outreach_dispo,'to','needs_sequence'),
        'acquisition_command',v_command_id);
  end if;
  return v_result;
end;
$function$;

do $$
declare v_left text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = any (array['fn_set_acquisition_designation','fn_set_acquisition_settings','fn_bind_acquisition_call_context','fn_record_acquisition_call_start','fn_log_acquisition_attempt_without_sms_obligation','my_leads_workflow_replay','fn_ready_acquisition_offer','fn_log_acquisition_offer','fn_record_acquisition_contract','fn_decline_acquisition_offer','fn_handoff_acquisition_lead','fn_archive_acquisition_contract','fn_finalize_acquisition_attempt_without_sms_obligation','fn_preview_acquisition_launch','fn_apply_acquisition_launch','fn_rollback_acquisition_launch','fn_handoff_acquisition_lead_to_drip'])
    and p.prosrc like '%40001%';
  if v_left is not null then
    raise exception 'My Leads functions still raise 40001: %', v_left;
  end if;
end;
$$;

commit;
