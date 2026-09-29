-- Authenticated Dialpad playback projection for the existing owner/My Recordings library.
-- Final-object locators remain server-only; the client receives only opaque IDs and
-- validated track metadata. This migration extends the historical projection in place
-- rather than rewriting its earlier migration.
begin;

create or replace function public.dialpad_recording_playback_file_id(
  p_capture_id uuid, p_track text, p_epoch integer
) returns text language sql immutable security definer set search_path = '' as $$
  select 'dpf_' || encode(extensions.digest(
    convert_to(p_capture_id::text || '|' || p_track || '|' || p_epoch::text, 'utf8'), 'sha256'
  ), 'hex');
$$;
revoke all on function public.dialpad_recording_playback_file_id(uuid,text,integer) from public,anon,authenticated,service_role;

-- Source inventory is assembled from the immutable capture -> intent -> call ->
-- acquisition binding. It intentionally returns no storage locator.
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
      join public.acquisition_attempts a on a.org_id=cap.org_id and a.call_activity_id=c.id
        and a.source='dialpad' and a.actor_user_id=cap.rep_user_id
      where cap.status in ('sealed','partial','failed')
        and (p_scope='owner' or cap.rep_user_id=p_actor)
        and not exists (select 1 from public.dialpad_call_events e
          where e.org_id=cap.org_id and e.matched_intent_id=cap.intent_id
            and (e.disposition='conflict' or e.conflicts_with_event_id is not null))
        and exists (select 1 from public.memberships m where m.org_id=cap.org_id and m.user_id=p_actor
          and m.access_status='active' and m.deletion_prepared_at is null
          and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
          and (p_scope='owner' and m.role='owner' or p_scope='mine' and m.acquisitions_enabled))
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

-- Playback lookup repeats the complete immutable binding and membership checks.
-- The path is emitted only inside the server-side DAL and only for a registered,
-- decode-valid final object in the private Dialpad bucket.
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
  join public.acquisition_attempts a on a.org_id=cap.org_id and a.call_activity_id=c.id
    and a.source='dialpad' and a.actor_user_id=cap.rep_user_id
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
      and e.matched_intent_id=cap.intent_id and (e.disposition='conflict' or e.conflicts_with_event_id is not null));
  return v_result;
end;
$$;
revoke all on function public.fn_dialpad_recording_playback_file(uuid,text,text) from public,anon,authenticated;
grant execute on function public.fn_dialpad_recording_playback_file(uuid,text,text) to service_role;

create or replace function public.recording_library_rows(p_actor uuid,p_scope text,p_audio jsonb)
returns table(id text,at timestamptz,actor_id uuid,actor_name text,active_acquisitions boolean,
  former boolean,conflicting boolean,source text,outcome text,direction text,purpose text,
  contact text,address text,phone text,property_id uuid,missing_association boolean,
  transcript boolean,summary boolean,status text,files jsonb)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.recording_library_require(p_actor,p_scope);
  return query
  with calls as (
    select 'call:'||c.id::text as id,coalesce(c.started_at,c.created_at) as at,
      case when (c.operator_user_id is not null and c.operator_user_id is distinct from proof.actor_id)
        or (a.actor_user_id is not null and a.actor_user_id is distinct from proof.actor_id)
        then null else proof.actor_id end as actor_id,
      coalesce(c.operator_user_id<>a.actor_user_id,false)
        or (proof.actor_id is not null and ((c.operator_user_id is not null and c.operator_user_id<>proof.actor_id)
          or (a.actor_user_id is not null and a.actor_user_id<>proof.actor_id))) as conflicting,
      c.provider as source,coalesce(nullif(c.disposition,''),c.outcome,'unknown') as outcome,
      c.direction,c.call_purpose as purpose,c.contact_id,c.property_id,c.phone_e164 as phone,
      c.transcript_status='available' as transcript,c.summary_status='available' as summary,
      coalesce(proof.recording_status,c.recording_status), c.id as call_id,
      c.jitter_attempt_id as attempt_key,c.jitter_session_id as scope_key,
      a.id as reference_id,a.recording_url as reference_url
    from public.call_activities c
    left join lateral (select (b->>'actorId')::uuid as actor_id, b->>'recordingStatus' as recording_status
      from jsonb_array_elements(p_audio) b where b->>'id'=c.id::text) proof on true
    left join public.acquisition_attempts a on a.org_id=c.org_id and a.call_activity_id=c.id
    where c.org_id='00000000-0000-0000-0000-000000000bbb'

    union all
    select 'attempt:'||a.id::text,a.occurred_at,a.actor_user_id,false,a.source,
      coalesce(a.outcome,'unknown'),'unknown','unknown',null,a.property_id,null,false,false,
      'external',null,null,null,a.id,a.recording_url
    from public.acquisition_attempts a
    where a.org_id='00000000-0000-0000-0000-000000000bbb' and a.call_activity_id is null
      and nullif(btrim(a.recording_url),'') is not null
  ), scoped as (
    select c.* from calls c where p_scope='owner' or (c.actor_id=p_actor and not c.conflicting)
  ), with_files as (
    select c.*,coalesce(f.files,'[]'::jsonb) as files from scoped c
    left join lateral (
      select jsonb_agg(x.file order by x.file->>'id') as files from (
        select jsonb_build_object('id',j->>'id','duration',j->'duration',
          'status',j->>'status','kind',coalesce(j->>'kind','stored'),'source','dialpad',
          'track',j->>'track','epoch',j->'epoch','completeness',j->>'completeness',
          'partialReason',j->>'partialReason','recordingStatus',j->>'recordingStatus') as file
        from jsonb_array_elements(coalesce((select b->'files' from jsonb_array_elements(p_audio) b where b->>'id'=c.call_id::text),'[]')) j
        where j->>'source'='dialpad'
        union all
        select jsonb_build_object('id','jitter:'||c.call_id::text||':'||(j->>'id'),'duration',j->'duration',
          'status',j->>'status','kind','stored','recordingId',j->>'id',
          'attemptKey',c.attempt_key,'scopeKey',c.scope_key) as file
        from jsonb_array_elements(coalesce((select b->'files' from jsonb_array_elements(p_audio) b where b->>'id'=c.call_id::text),'[]')) j
        where coalesce(j->>'source','')<>'dialpad'
        union all
        select jsonb_build_object('id','recording:'||r.id::text,'duration',r.duration_seconds,
          'status',case when r.status='available' and nullif(btrim(r.storage_path),'') is null then 'missing'
            when r.status='available' and (c.source not in ('jitter','sandra_softphone') or nullif(btrim(c.scope_key),'') is null or nullif(btrim(c.attempt_key),'') is null) then 'external'
            when r.status='available' then 'external' else r.status end,
          'kind','stored','storagePath',r.storage_path,'attemptKey',c.attempt_key,'scopeKey',c.scope_key) as file
        from public.call_recordings r where r.call_activity_id=c.call_id and c.source <> 'dialpad'
          and not exists(select 1 from jsonb_array_elements(coalesce((select b->'files' from jsonb_array_elements(p_audio) b where b->>'id'=c.call_id::text),'[]')) j where (j->>'matchesSummary')::boolean)
        union all
        select jsonb_build_object('id','reference:'||c.reference_id::text,'duration',null,
          'status','external','kind','reference','url',c.reference_url)
        where nullif(btrim(c.reference_url),'') is not null
      ) x
    ) f on true
  )
  select c.id,c.at,c.actor_id,
    coalesce(nullif(u.raw_app_meta_data->>'display_name',''),nullif(u.raw_app_meta_data->>'full_name',''),u.email,
      case when c.actor_id is null then 'Unattributed' else 'Former user' end),
    coalesce(m.access_status='active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at>statement_timestamp()) and m.acquisitions_enabled,false),
    c.actor_id is not null and (m.user_id is null or m.access_status<>'active' or m.deletion_prepared_at is not null
      or m.access_expires_at<=statement_timestamp()),c.conflicting,c.source,c.outcome,c.direction,c.purpose,
    coalesce(nullif(ct.entity_name,''),nullif(concat_ws(' ',ct.first_name,ct.last_name),''),'Unknown contact'),
    coalesce(nullif(concat_ws(', ',p.address,p.city,p.state),''),'No linked property'),c.phone,c.property_id,
    c.call_id is null or p.id is null or jsonb_array_length(c.files)=0,c.transcript,c.summary,
    case when jsonb_array_length(c.files)=0 then case when c.recording_status in ('pending','partial','failed') then c.recording_status else 'missing' end
      when exists (select 1 from jsonb_array_elements(c.files) e where e->>'recordingStatus' in ('partial','failed') or e->>'completeness'='partial') then 'partial'
      when (select count(distinct e->>'status') from jsonb_array_elements(c.files) e)>1 then 'partial'
      else c.files->0->>'status' end,
    c.files
  from with_files c
  left join auth.users u on u.id=c.actor_id
  left join public.memberships m on m.user_id=c.actor_id and m.org_id='00000000-0000-0000-0000-000000000bbb'
  left join public.properties p on p.id=c.property_id and p.org_id='00000000-0000-0000-0000-000000000bbb'
  left join public.contacts ct on ct.id=c.contact_id and ct.org_id='00000000-0000-0000-0000-000000000bbb'
  where c.recording_status<>'none' or jsonb_array_length(c.files)>0;
end;
$$;

create or replace function public.fn_recording_library_search(p_actor uuid,p_scope text,p_filters jsonb,p_audio jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform public.recording_library_require(p_actor,p_scope);
  if p_scope='mine' and (coalesce(jsonb_array_length(p_filters->'users'),0)>0
    or coalesce(p_filters->>'group','all')<>'all' or coalesce(p_filters->>'association','all')<>'all') then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  with scoped as materialized(select * from public.recording_library_rows(p_actor,p_scope,p_audio)),
  filtered as materialized (
    select r.* from scoped r
    where (p_filters->>'from' is null or r.at>=(p_filters->>'from')::timestamptz)
      and (p_filters->>'until' is null or r.at<(p_filters->>'until')::timestamptz)
      and (coalesce(p_filters->>'q','')='' or strpos(lower(concat_ws(' ',r.contact,r.address,r.phone)),lower(p_filters->>'q'))>0)
      and (coalesce(p_filters->>'source','')='' or r.source=p_filters->>'source')
      and (coalesce(p_filters->>'outcome','')='' or r.outcome=p_filters->>'outcome')
      and (coalesce(p_filters->>'direction','all')='all' or r.direction=p_filters->>'direction')
      and (coalesce(p_filters->>'purpose','all')='all' or r.purpose=p_filters->>'purpose')
      and (coalesce(p_filters->>'transcript','all')='all' or r.transcript=(p_filters->>'transcript'='yes'))
      and (coalesce(p_filters->>'summary','all')='all' or r.summary=(p_filters->>'summary'='yes'))
      and (coalesce(p_filters->>'association','all')='all' or r.missing_association)
      and (case coalesce(p_filters->>'group','all') when 'acquisitions' then r.active_acquisitions when 'former' then r.former when 'unattributed' then r.actor_id is null else true end)
      and (coalesce(jsonb_array_length(p_filters->'users'),0)=0 or r.actor_id::text in(select jsonb_array_elements_text(p_filters->'users')))
      and ((p_filters->>'min' is null and p_filters->>'max' is null) or exists(
        select 1 from jsonb_array_elements(r.files) f where f->>'duration' is not null
          and (p_filters->>'min' is null or (f->>'duration')::integer>=(p_filters->>'min')::integer)
          and (p_filters->>'max' is null or (f->>'duration')::integer<=(p_filters->>'max')::integer)))
  ), matching as materialized (
    select r.* from filtered r where coalesce(p_filters->>'status','available')='all'
      or (p_filters->>'status'='partial' and r.status='partial')
      or exists(select 1 from jsonb_array_elements(r.files) f
        where f->>'status'=coalesce(p_filters->>'status','available')
          and (p_filters->>'min' is null or (f->>'duration')::integer>=(p_filters->>'min')::integer)
          and (p_filters->>'max' is null or (f->>'duration')::integer<=(p_filters->>'max')::integer))
      or (jsonb_array_length(r.files)=0 and r.status=coalesce(p_filters->>'status','available')
        and p_filters->>'min' is null and p_filters->>'max' is null)
  ), page as (
    select r.* from matching r where p_filters->'after' is null or p_filters->'after'='null'::jsonb
      or (r.at,r.id)<((p_filters->'after'->>'at')::timestamptz,p_filters->'after'->>'id')
    order by r.at desc,r.id desc limit 51
  ), safe_page as (
    select p.at,p.id,(to_jsonb(p)-'files')||jsonb_build_object('files',(
      select coalesce(jsonb_agg(jsonb_build_object('id',f->>'id','duration',f->'duration','status',f->>'status','kind',f->>'kind',
        'source',f->>'source','track',f->>'track','epoch',f->'epoch','completeness',f->>'completeness',
        'partialReason',f->>'partialReason','recordingStatus',f->>'recordingStatus')),'[]')
      from jsonb_array_elements(p.files) f)) as item from page p
  )
  select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(s.item order by s.at desc,s.id desc) from safe_page s),'[]'),
    'total',(select count(*) from matching),
    'availability',coalesce((select jsonb_object_agg(x.status,x.n) from (select r.status,count(*) n from filtered r group by r.status)x),'{}'),
    'sources',coalesce((select jsonb_agg(x.source order by x.source) from(select distinct r.source from scoped r)x),'[]'),
    'outcomes',coalesce((select jsonb_agg(x.outcome order by x.outcome) from(select distinct r.outcome from scoped r)x),'[]'),
    'users',case when p_scope='owner' then coalesce((select jsonb_agg(jsonb_build_object('id',x.actor_id,'name',x.actor_name) order by x.actor_name)
      from(select distinct r.actor_id,r.actor_name from scoped r where r.actor_id is not null)x),'[]') else '[]'::jsonb end
  ) into v_result;
  return v_result;
end;
$$;

commit;
