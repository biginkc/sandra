begin;
do $patch$
declare
  v_sig constant text := 'public.fn_log_acquisition_attempt_without_sms_obligation(jsonb)';
  v_def text;
  r record;
begin
  v_def:=pg_get_functiondef(v_sig::regprocedure);
  for r in select * from (values
($old$  -- Finalized matches also route here: existing single-shot protection rejects a new key.
  if cardinality(v_recording_matches)=1 then
    select * into strict v_recording_match from public.acquisition_attempts where id=v_recording_matches[1];
    v_result:=public.fn_finalize_acquisition_attempt_without_sms_obligation(
      p_input || jsonb_build_object('orgId',v_org,'callActivityId',v_recording_match.call_activity_id));
    select * into v_queue from public.acquisition_queue_states where property_id=v_property_id and org_id=v_org;
    v_result:=v_result || jsonb_build_object('assignmentEpisodeId',v_recording_match.assignment_episode_id,
      'queueVersion',coalesce(v_queue.version,0),'stage',v_queue.stage,'archived',false);
    -- Preserve the original log operation/hash for retries and workflow reconciliation.
    insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
      values(v_command,v_org,v_actor,'user','log_acquisition_attempt',v_key,v_hash,v_result);
    return v_result;
  end if;
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command,v_org,v_actor,'user','log_acquisition_attempt',v_key,v_hash,'{}');$old$,$new$  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command,v_org,v_actor,'user','log_acquisition_attempt',v_key,v_hash,'{}');$new$),
($old$  -- Match only exact recording evidence within this caller and lead. Lock attempts BEFORE
  -- property/queue rows, matching provider projection and finalize lock order.
  if v_source='dialpad' and nullif(btrim(p_input->>'recordingUrl'),'') is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_org::text||':finalize-command:'||v_key::text,0));
    select array_agg(a.id) into v_recording_matches from (
      select a.id from public.acquisition_attempts a
      where a.org_id=v_org and a.property_id=v_property_id and a.actor_user_id=v_actor
        and a.source='dialpad' and public.dialpad_cti_is_ledger_key(a.provider_attempt_key)
        and a.call_activity_id is not null
        and btrim(a.recording_url)=btrim(p_input->>'recordingUrl')
      order by a.id for update
    ) a;
    if cardinality(v_recording_matches)>1 then
      raise exception 'AMBIGUOUS_CALL_REFERENCE' using errcode='MLS01';
    end if;
  end if;
  select * into v_property from public.properties where id=v_property_id and org_id=v_org for update;$old$,$new$  select * into v_property from public.properties where id=v_property_id and org_id=v_org for update;$new$),
($old$  v_command uuid:=extensions.gen_random_uuid();
  v_recording_matches uuid[];
  v_recording_match public.acquisition_attempts%rowtype;$old$,$new$  v_command uuid:=extensions.gen_random_uuid();$new$)
  ) patches(old_text,new_text) loop
    if (length(v_def)-length(replace(v_def,r.old_text,'')))/length(r.old_text) <> 1 then
      raise exception 'DialPad reconciliation: expected exactly one patch anchor';
    end if;
    v_def:=replace(v_def,r.old_text,r.new_text);
  end loop;
  execute v_def;
end $patch$;
commit;
