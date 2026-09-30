-- Extend the authenticated Dialpad recording projection to the permanent
-- internal-training call path. Training calls intentionally have no
-- acquisition_attempts row, so they need their own immutable provenance proof.
-- Customer calls retain the historical attempt-backed path unchanged.
begin;

-- Keep the provider identity frozen once a Dialpad training activity has been
-- established. The existing training guard intentionally permits ordinary
-- wrap-up/provider artifact updates, so this remains narrow: customer calls
-- and Sandra softphone training calls retain their historical behavior.
create or replace function public.guard_homeowner_training_call() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    if new.call_purpose = 'internal_training' and coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'Only the server may create training calls' using errcode = '42501';
    end if;
  elsif new.call_purpose is distinct from old.call_purpose then
    raise exception 'Call purpose is immutable' using errcode = '23514';
  end if;
  if TG_OP = 'UPDATE' and old.call_purpose = 'internal_training' and (
    new.org_id is distinct from old.org_id or new.provider is distinct from old.provider
    or new.jitter_attempt_id is distinct from old.jitter_attempt_id
    or (new.operator_user_id is not null and new.operator_user_id is distinct from old.operator_user_id)
    or new.phone_e164 is distinct from old.phone_e164
    or (old.provider = 'dialpad' and old.provider_call_id is not null and new.provider_call_id is distinct from old.provider_call_id)
  ) then
    raise exception 'Training call identity is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.fn_dialpad_recording_library_sources(p_actor uuid,p_scope text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if p_actor is null or p_scope not in ('owner','mine') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  return (
    with eligible as (
      select c.id as call_id, cap.id as capture_id, cap.rep_user_id, cap.status
      from public.dialpad_recording_captures cap
      join public.dialpad_call_intents i on i.id=cap.intent_id and i.org_id=cap.org_id
        and i.rep_user_id=cap.rep_user_id and i.matched_provider_call_id=cap.provider_call_id
        and i.status='matched'
      join public.call_activities c on c.id=cap.call_activity_id and c.org_id=cap.org_id
        and c.provider='dialpad' and c.provider_call_id=cap.provider_call_id
        and c.operator_user_id=cap.rep_user_id
      where cap.status in ('sealed','partial','failed')
        and (p_scope='owner' or cap.rep_user_id=p_actor)
        and not exists (select 1 from public.dialpad_call_events e
          where e.org_id=cap.org_id and e.matched_intent_id=cap.intent_id
            and (e.disposition='conflict' or e.conflicts_with_event_id is not null))
        and exists (select 1 from public.memberships m where m.org_id=cap.org_id and m.user_id=p_actor
          and m.access_status='active' and m.deletion_prepared_at is null
          and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
          and (p_scope='owner' and m.role='owner' or p_scope='mine' and m.acquisitions_enabled))
        and (
          (
            c.call_purpose<>'internal_training'
            and exists (select 1 from public.acquisition_attempts a
              where a.org_id=cap.org_id and a.call_activity_id=c.id
                and a.source='dialpad' and a.actor_user_id=cap.rep_user_id)
          )
          or (
            c.call_purpose='internal_training'
            and c.property_id is null and c.contact_id is null
            and c.jitter_attempt_id='dialpad-cti:'||i.id::text
            and exists (select 1 from public.properties p
              where p.id=i.property_id and p.org_id=i.org_id and p.is_training)
            and exists (select 1 from public.dialpad_call_events e
              where e.org_id=cap.org_id and e.matched_intent_id=cap.intent_id
                and e.provider_call_id=cap.provider_call_id and e.disposition='matched')
            and not exists (select 1 from public.acquisition_attempts a
              where a.org_id=cap.org_id and a.call_activity_id=c.id)
          )
        )
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',e.call_id::text,'actorId',e.rep_user_id,'source','dialpad',
      'recordingStatus',e.status,
      'files',(select coalesce(jsonb_agg(jsonb_build_object(
        'id',public.dialpad_recording_playback_file_id(f.capture_id,f.track,f.epoch),
        'duration',round(f.decoded_duration_ms::numeric/1000,3),'status','available','kind','stored',
        'source','dialpad','track',f.track,'epoch',f.epoch,'completeness',f.completeness,
        'partialReason',f.partial_reason,'recordingStatus',e.status) order by f.track,f.epoch),'[]'::jsonb)
        from public.dialpad_recording_track_finals f
        where f.capture_id=e.capture_id and f.decode_ok and f.storage_path is not null
          and f.storage_path=public.dialpad_recording_final_path(f.org_id,f.capture_id,f.epoch,f.track)
          and f.completeness in ('complete','partial'))
    ) order by e.call_id),'[]'::jsonb)
    from eligible e
  );
end;
$$;
revoke all on function public.fn_dialpad_recording_library_sources(uuid,text) from public,anon,authenticated;
grant execute on function public.fn_dialpad_recording_library_sources(uuid,text) to service_role;

create or replace function public.fn_dialpad_recording_playback_file(p_actor uuid,p_scope text,p_file_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if p_actor is null or p_scope not in ('owner','mine') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_file_id is null or p_file_id !~ '^dpf_[0-9a-f]{64}$' then return null; end if;
  select jsonb_build_object(
    'callId','call:'||c.id::text,'source','dialpad',
    'file',jsonb_build_object(
      'id',public.dialpad_recording_playback_file_id(f.capture_id,f.track,f.epoch),
      'duration',round(f.decoded_duration_ms::numeric/1000,3),'status','available','kind','stored',
      'source','dialpad','track',f.track,'epoch',f.epoch,'completeness',f.completeness,
      'partialReason',f.partial_reason,'recordingStatus',cap.status,
      'captureId',f.capture_id,'orgId',f.org_id,'bucket','dialpad-recordings','storagePath',f.storage_path
    )
  ) into v_result
  from public.dialpad_recording_track_finals f
  join public.dialpad_recording_captures cap on cap.id=f.capture_id and cap.org_id=f.org_id
  join public.dialpad_call_intents i on i.id=cap.intent_id and i.org_id=cap.org_id
    and i.rep_user_id=cap.rep_user_id and i.matched_provider_call_id=cap.provider_call_id and i.status='matched'
  join public.call_activities c on c.id=cap.call_activity_id and c.org_id=cap.org_id
    and c.provider='dialpad' and c.provider_call_id=cap.provider_call_id and c.operator_user_id=cap.rep_user_id
  where public.dialpad_recording_playback_file_id(f.capture_id,f.track,f.epoch)=p_file_id
    and cap.status in ('sealed','partial','failed')
    and (p_scope='owner' or cap.rep_user_id=p_actor)
    and f.decode_ok and f.storage_path is not null
    and f.storage_path=public.dialpad_recording_final_path(f.org_id,f.capture_id,f.epoch,f.track)
    and f.completeness in ('complete','partial')
    and exists (select 1 from public.memberships m where m.org_id=cap.org_id and m.user_id=p_actor
      and m.access_status='active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
      and (p_scope='owner' and m.role='owner' or p_scope='mine' and m.acquisitions_enabled))
    and not exists (select 1 from public.dialpad_call_events e where e.org_id=cap.org_id
      and e.matched_intent_id=cap.intent_id and (e.disposition='conflict' or e.conflicts_with_event_id is not null))
    and (
      (
        c.call_purpose<>'internal_training'
        and exists (select 1 from public.acquisition_attempts a
          where a.org_id=cap.org_id and a.call_activity_id=c.id
            and a.source='dialpad' and a.actor_user_id=cap.rep_user_id)
      )
      or (
        c.call_purpose='internal_training'
        and c.property_id is null and c.contact_id is null
        and c.jitter_attempt_id='dialpad-cti:'||i.id::text
        and exists (select 1 from public.properties p
          where p.id=i.property_id and p.org_id=i.org_id and p.is_training)
        and exists (select 1 from public.dialpad_call_events e
          where e.org_id=cap.org_id and e.matched_intent_id=cap.intent_id
            and e.provider_call_id=cap.provider_call_id and e.disposition='matched')
        and not exists (select 1 from public.acquisition_attempts a
          where a.org_id=cap.org_id and a.call_activity_id=c.id)
      )
    );
  return v_result;
end;
$$;
revoke all on function public.fn_dialpad_recording_playback_file(uuid,text,text) from public,anon,authenticated;
grant execute on function public.fn_dialpad_recording_playback_file(uuid,text,text) to service_role;

commit;
