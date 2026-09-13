begin;
alter table public.call_activities alter column jitter_attempt_id drop not null;
alter table public.call_activities add constraint dialpad_call_identity_check check (
  (provider='dialpad' and provider_call_id is not null and provider_call_id ~ '^[0-9]+$')
  or (provider<>'dialpad' and jitter_attempt_id is not null));
create unique index dialpad_call_provider_identity_idx on public.call_activities(org_id,provider_call_id) where provider='dialpad';
alter table public.acquisition_attempts drop constraint acquisition_attempts_pending_outcome_check;
alter table public.acquisition_attempts add constraint acquisition_attempts_pending_outcome_check check (
  source='sandra' or outcome is not null or (source='dialpad' and provider_attempt_key is not null and command_id is not null));
create unique index dialpad_acquisition_provider_identity_idx on public.acquisition_commands(org_id,(result->>'providerCallId'))
  where operation='record_dialpad_call_start' and result->>'providerCallId' is not null;

-- Retain provider-connected duration separately; never infer measured seller talk time.
create function public.dialpad_enrich_activity(p_activity uuid,p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_end timestamptz; v_duration integer; v_expected boolean;
begin
  if coalesce(p_payload->>'date_ended','') ~ '^[0-9]+$' and (p_payload->>'date_ended')::numeric between 1 and 253402300799000 then
    v_end:=to_timestamp(((p_payload->>'date_ended')::numeric/1000)::double precision);
  end if;
  if v_end is not null and coalesce(p_payload->>'duration','') ~ '^[0-9]+(\.[0-9]+)?$' and (p_payload->>'duration')::numeric<=2147483647000 then
    v_duration:=floor((p_payload->>'duration')::numeric/1000)::integer;
  end if;
  if p_payload->'was_recorded'='true'::jsonb then v_expected:=true; end if;
  if jsonb_typeof(p_payload->'recording_details')='array' and jsonb_array_length(p_payload->'recording_details')>0 then v_expected:=true; end if;
  update public.call_activities set
    provider_ended_at=coalesce(provider_ended_at,case when v_end>=started_at and v_end<=statement_timestamp()+interval '5 minutes' then v_end end),
    ended_at=coalesce(ended_at,case when v_end>=started_at and v_end<=statement_timestamp()+interval '5 minutes' then v_end end),
    duration_seconds=coalesce(duration_seconds,v_duration),recording_expected=case when v_expected is true then true else recording_expected end
    where id=p_activity and provider='dialpad';
end;
$$;
revoke all on function public.dialpad_enrich_activity(uuid,jsonb) from public,anon,authenticated,service_role;

-- Inputs select persisted facts, never supply caller-authored provider evidence.
create function public.fn_record_dialpad_acquisition_call_start(p_intent_id uuid,p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_intent public.dialpad_voice_intents%rowtype;
  v_event public.dialpad_voice_event_inbox%rowtype;
  v_receipt public.acquisition_commands%rowtype;
  v_activity public.call_activities%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_payload jsonb;
  v_call text;
  v_at timestamptz;
  v_ms numeric;
  v_event_ms numeric;
  v_attempt uuid;
  v_command uuid:=extensions.gen_random_uuid();
  v_result jsonb;
begin
  select * into v_intent from public.dialpad_voice_intents where id=p_intent_id for update;
  if not found then raise exception 'DIALPAD_INTENT_MISSING' using errcode='P0002'; end if;
  select * into v_event from public.dialpad_voice_event_inbox where id=p_receipt_id and org_id=v_intent.org_id;
  if not found then raise exception 'DIALPAD_RECEIPT_MISSING' using errcode='P0002'; end if;
  v_payload:=v_event.payload;
  v_call:=v_payload->>'call_id';
  if v_call is null or v_call !~ '^[0-9]+$'
    or (jsonb_typeof(v_payload->'call_id')='number' and v_call::numeric>9007199254740991)
    or (jsonb_typeof(v_payload#>'{target,id}')='number' and (v_payload#>>'{target,id}')::numeric>9007199254740991)
    or v_payload->>'custom_data' is distinct from v_intent.id::text
    or v_payload->>'direction' is distinct from 'outbound'
    or lower(v_payload#>>'{target,type}') is distinct from 'user'
    or v_payload#>>'{target,id}' is distinct from v_intent.dialpad_user_id
    or v_payload->>'internal_number' is distinct from v_intent.caller_id_e164
    or v_payload->>'external_number' is distinct from v_intent.destination_e164
    or coalesce(v_payload->>'state','') not in ('calling','ringing','connected','hangup','missed','recording','call_transcription')
    or coalesce(v_payload->>'date_started','') !~ '^[0-9]+$'
    or coalesce(v_payload->>'event_timestamp','') !~ '^[0-9]+$' then
    raise exception 'DIALPAD_START_EVIDENCE_INCOMPLETE' using errcode='23514';
  end if;
  v_ms:=(v_payload->>'date_started')::numeric;
  v_event_ms:=(v_payload->>'event_timestamp')::numeric;
  if v_ms<=0 or v_ms>253402300799000 or v_ms>v_event_ms
    or v_event_ms>extract(epoch from v_event.received_at)*1000+300000
    or v_ms<extract(epoch from v_intent.created_at)*1000-300000 then
    raise exception 'DIALPAD_START_TIME_INVALID' using errcode='23514';
  end if;
  v_at:=to_timestamp((v_ms/1000)::double precision);
  if v_intent.provider_call_id is not null and v_intent.provider_call_id<>v_call then
    raise exception 'DIALPAD_CALL_IDENTITY_CONFLICT' using errcode='23514';
  end if;
  -- Serialize aliases as well as intents: two distinct intents cannot claim one call.
  perform pg_advisory_xact_lock(hashtextextended(v_intent.org_id::text||':dialpad-call:'||v_call,0));
  select * into v_receipt from public.acquisition_commands where org_id=v_intent.org_id and operation='record_dialpad_call_start' and context_key_hash=v_intent.binding_token_hash;
  if found then
    if v_receipt.result->>'providerCallId' is distinct from v_call then raise exception 'DIALPAD_CALL_IDENTITY_CONFLICT' using errcode='23514'; end if;
    perform public.dialpad_enrich_activity((v_receipt.result->>'callActivityId')::uuid,v_payload);
    return jsonb_set(v_receipt.result,'{duplicate}','true'::jsonb);
  end if;
  if exists(select 1 from public.acquisition_commands where org_id=v_intent.org_id and operation='record_dialpad_call_start' and result->>'providerCallId'=v_call) then
    raise exception 'DIALPAD_CALL_ALREADY_BOUND' using errcode='23514';
  end if;
  select * into v_property from public.properties where id=v_intent.property_id and org_id=v_intent.org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select * into v_episode from public.acquisition_assignment_episodes where id=v_intent.assignment_episode_id and property_id=v_intent.property_id and org_id=v_intent.org_id for update;
  if v_intent.assignment_episode_id is not null and not found then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  select * into v_queue from public.acquisition_queue_states where property_id=v_intent.property_id and org_id=v_intent.org_id for update;
  select * into v_activity from public.call_activities where org_id=v_intent.org_id and provider='dialpad' and provider_call_id=v_call for update;
  if found then
    if v_activity.property_id is distinct from v_intent.property_id or v_activity.operator_user_id is distinct from v_intent.actor_user_id
      or v_activity.phone_e164 is distinct from v_intent.destination_e164 or v_activity.direction is distinct from 'outbound'
      or v_activity.started_at is distinct from v_at then
      raise exception 'DIALPAD_ACTIVITY_IDENTITY_CONFLICT' using errcode='23514';
    end if;
  else
    insert into public.call_activities(org_id,property_id,operator_user_id,provider,provider_call_id,started_at,direction,phone_e164,wrap_token,recording_status,transcript_status)
      values(v_intent.org_id,v_intent.property_id,v_intent.actor_user_id,'dialpad',v_call,v_at,'outbound',v_intent.destination_e164,v_intent.id,'pending','pending') returning * into v_activity;
  end if;
  update public.dialpad_voice_intents set provider_call_id=v_call,status='linked' where id=v_intent.id;
  insert into public.acquisition_commands(id,org_id,actor_kind,operation,idempotency_key,request_hash,context_key_hash,result)
    values(v_command,v_intent.org_id,'service','record_dialpad_call_start',v_intent.id,v_intent.binding_token_hash,v_intent.binding_token_hash,'{}');
  insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,call_activity_id,provider_attempt_key,idempotency_key,command_id)
    values(v_intent.org_id,v_intent.property_id,v_intent.assignment_episode_id,v_intent.actor_user_id,'call','dialpad',v_at,v_activity.id,v_intent.binding_token_hash,v_intent.id,v_command) returning id into v_attempt;
  if v_episode.eligible and v_episode.assignee_user_id=v_intent.actor_user_id and v_at>=v_episode.assigned_at and (v_episode.ended_at is null or v_at<v_episode.ended_at) then
    update public.acquisition_assignment_episodes set first_call_started_at=v_at,first_call_actor_user_id=v_intent.actor_user_id,first_call_provider_key=v_intent.binding_token_hash
      where id=v_episode.id and (first_call_started_at is null or first_call_started_at>v_at);
  end if;
  if v_episode.id is not null and v_episode.ended_at is null and v_episode.assignee_user_id=v_property.assigned_user_id
    and v_at>=coalesce(v_episode.assigned_at,v_episode.initialized_at) and v_queue.archived_at is null
    and v_property.deleted_at is null and not coalesce(v_property.is_dnc_locked,false)
    and v_property.status::text not in ('closed','dead','dnc')
    and exists(select 1 from public.acquisition_org_settings where org_id=v_intent.org_id and my_leads_enabled) then
    if v_queue.property_id is null then
      insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,version) values(v_intent.property_id,v_intent.org_id,'contacted',v_at,1);
    end if;
    if v_property.status::text in ('prospect','new_lead') then update public.properties set status='contacted' where id=v_property.id; end if;
  end if;
  perform public.dialpad_enrich_activity(v_activity.id,v_payload);
  v_result:=jsonb_build_object('ok',true,'tracked',true,'duplicate',false,'propertyId',v_intent.property_id,'attemptId',v_attempt,'callActivityId',v_activity.id,'providerCallId',v_call,'intentId',v_intent.id,'receiptId',v_event.id);
  update public.acquisition_commands set result=v_result where id=v_command;
  return v_result;
end;
$$;
revoke all on function public.fn_record_dialpad_acquisition_call_start(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_record_dialpad_acquisition_call_start(uuid,uuid) to service_role;

create function public.dialpad_guard_acquisition_activity_identity()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.acquisition_attempts a join public.acquisition_commands r on r.id=a.command_id
    join public.dialpad_voice_intents i on i.id=(r.result->>'intentId')::uuid
    where a.call_activity_id=old.id and a.source='dialpad' and r.operation='record_dialpad_call_start'
      and (new.org_id is distinct from a.org_id or new.property_id is distinct from a.property_id
        or new.operator_user_id is distinct from a.actor_user_id or new.provider is distinct from 'dialpad'
        or new.provider_call_id is distinct from r.result->>'providerCallId'
        or new.phone_e164 is distinct from i.destination_e164 or new.direction is distinct from 'outbound'
        or new.started_at is distinct from a.occurred_at or new.wrap_token is distinct from old.wrap_token)) then
    raise exception 'ACQUISITION_CALL_IDENTITY_CONFLICT' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function public.dialpad_guard_acquisition_activity_identity() from public,anon,authenticated,service_role;
create trigger dialpad_acquisition_activity_identity before update on public.call_activities for each row execute function public.dialpad_guard_acquisition_activity_identity();

create or replace function public.fn_finalize_acquisition_attempt(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
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
    if v_receipt.request_hash is distinct from v_hash then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
    return jsonb_set(v_receipt.result,'{duplicate}','true');
  end if;
  select * into v_attempt from public.acquisition_attempts where org_id=v_org and call_activity_id=v_activity
    and property_id=(p_input->>'propertyId')::uuid and actor_user_id=v_actor
    and (source='sandra' or (source='dialpad' and provider_attempt_key is not null and exists(select 1 from public.acquisition_commands r where r.id=acquisition_attempts.command_id and r.org_id=v_org and r.operation='record_dialpad_call_start' and r.result->>'attemptId'=acquisition_attempts.id::text)))
    and (p_input->>'source' is null or source=p_input->>'source') for update;
  if not found then raise exception 'PROVIDER_EVIDENCE_PENDING' using errcode='42501'; end if;
  if v_attempt.outcome is distinct from p_input->>'outcome' and exists(
    select 1 from public.acquisition_commands r where r.org_id=v_org
      and r.operation='finalize_acquisition_attempt' and r.result->>'attemptId'=v_attempt.id::text
  ) then raise exception 'STALE_STATE' using errcode='40001'; end if;
  update public.acquisition_attempts set outcome=p_input->>'outcome',note=coalesce(nullif(btrim(p_input->>'note'),''),note),
    recording_url=coalesce(nullif(btrim(p_input->>'recordingUrl'),''),recording_url) where id=v_attempt.id;
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',v_attempt.property_id,'attemptId',v_attempt.id);
  insert into public.acquisition_commands(org_id,actor_kind,actor_user_id,operation,idempotency_key,request_hash,result)
    values(v_org,'user',v_actor,'finalize_acquisition_attempt',v_key,v_hash,v_result);
  return v_result;
end;
$$;
revoke all on function public.fn_finalize_acquisition_attempt(jsonb) from public,anon,service_role;
grant execute on function public.fn_finalize_acquisition_attempt(jsonb) to authenticated;

create or replace function public.fn_get_acquisition_call_references(p_org_id uuid,p_property_id uuid,p_member_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=auth.uid()
    and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  perform public.my_leads_require_read_scope(p_org_id,p_member_id);
  if not exists(select 1 from public.properties p where p.id=p_property_id and p.org_id=p_org_id
    and p.assigned_user_id=p_member_id and p.deleted_at is null) then
    raise exception 'STALE_ASSIGNMENT' using errcode='42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id',a.call_activity_id,'occurredAt',a.occurred_at,'source',a.source) order by a.occurred_at desc),'[]')
    from (select call_activity_id,occurred_at,source from public.acquisition_attempts where org_id=p_org_id and property_id=p_property_id
      and actor_user_id=auth.uid() and (source='sandra' or (source='dialpad' and provider_attempt_key is not null and exists(select 1 from public.acquisition_commands r where r.id=acquisition_attempts.command_id and r.org_id=p_org_id and r.operation='record_dialpad_call_start'))) and outcome is null and call_activity_id is not null order by occurred_at desc limit 20) a);
end;
$$;
revoke all on function public.fn_get_acquisition_call_references(uuid,uuid,uuid) from public,anon,service_role;
grant execute on function public.fn_get_acquisition_call_references(uuid,uuid,uuid) to authenticated;

create function public.fn_claim_dialpad_voice_events(p_org_id uuid,p_limit integer default 10,p_lease_seconds integer default 60)
returns setof public.dialpad_voice_event_inbox language plpgsql security definer set search_path='' as $$
begin
  if p_org_id is null or p_limit is null or p_limit<1 or p_limit>100 or p_lease_seconds is null or p_lease_seconds<10 or p_lease_seconds>900 then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  return query with candidates as (
    select id from public.dialpad_voice_event_inbox
      where org_id=p_org_id and ((status in ('pending','retry') and next_attempt_at<=statement_timestamp())
        or (status='processing' and lease_expires_at<=statement_timestamp()))
      order by received_at,id for update skip locked limit p_limit
  ) update public.dialpad_voice_event_inbox e set status='processing',attempt_count=e.attempt_count+1,
      lease_token=extensions.gen_random_uuid(),lease_expires_at=statement_timestamp()+make_interval(secs=>p_lease_seconds)
    from candidates c where e.id=c.id returning e.*;
end;
$$;
revoke all on function public.fn_claim_dialpad_voice_events(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.fn_claim_dialpad_voice_events(uuid,integer,integer) to service_role;
commit;
