begin;
create unique index acquisition_call_start_seller_alias_idx
  on public.acquisition_commands(org_id, (result->>'sellerProviderCallId'))
  where operation='record_call_start' and result->>'sellerProviderCallId' is not null;
create unique index acquisition_call_start_jitter_alias_idx
  on public.acquisition_commands(org_id, (result->>'jitterCallId'))
  where operation='record_call_start' and result->>'jitterCallId' is not null;
-- Authenticated internal adapter only. No browser may manufacture provider evidence.
create or replace function public.fn_bind_acquisition_call_context(
  p_org_id uuid, p_property_id uuid, p_actor_user_id uuid, p_token_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
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
    if v_existing.request_hash <> v_hash then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
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
$$;

create or replace function public.fn_record_acquisition_call_start(p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
    if v_receipt.request_hash is distinct from v_hash then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
    return jsonb_set(v_receipt.result,'{duplicate}','true'::jsonb);
  end if;
  select * into v_property from public.properties where id=v_property_id and org_id=v_org for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select * into v_queue from public.acquisition_queue_states where property_id=v_property_id and org_id=v_org for update;
  select * into v_episode from public.acquisition_assignment_episodes where id=v_episode_id and property_id=v_property_id and org_id=v_org for update;
  if v_episode_id is not null and not found then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
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
$$;
revoke all on function public.fn_bind_acquisition_call_context(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.fn_record_acquisition_call_start(jsonb) from public,anon,authenticated;
grant execute on function public.fn_bind_acquisition_call_context(uuid,uuid,uuid,text) to service_role;
grant execute on function public.fn_record_acquisition_call_start(jsonb) to service_role;
commit;
