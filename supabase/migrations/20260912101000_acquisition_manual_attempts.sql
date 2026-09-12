begin;
create or replace function public.fn_log_acquisition_attempt(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
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
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001';
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
  if v_property.status is distinct from p_input->>'expectedSharedStatus' then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_queue from public.acquisition_queue_states where property_id=v_property_id and org_id=v_org for update;
  select * into v_episode from public.acquisition_assignment_episodes where property_id=v_property_id and org_id=v_org and ended_at is null for update;
  if v_episode.id is distinct from v_expected_episode then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  if coalesce(v_queue.version,0)<>v_version or v_queue.archived_at is not null then raise exception 'STALE_STATE' using errcode='40001'; end if;
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
$$;
revoke all on function public.fn_log_acquisition_attempt(jsonb) from public,anon;
grant execute on function public.fn_log_acquisition_attempt(jsonb) to authenticated;
commit;
