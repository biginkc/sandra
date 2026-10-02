-- Restore the existing Jitter/Dialpad library projections before removing direct recording cataloging.
begin;

create or replace function public.fn_recording_library_sources(p_actor uuid,p_scope text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform public.recording_library_require(p_actor,p_scope);
  return (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'attemptId',c.jitter_attempt_id,
    'scopeId',c.jitter_session_id,'summaryPath',r.storage_path)),'[]')
    from public.call_activities c
    left join public.call_recordings r on r.call_activity_id=c.id
    left join public.acquisition_attempts a on a.call_activity_id=c.id and a.org_id=c.org_id
    where c.org_id='00000000-0000-0000-0000-000000000bbb'
      and c.provider in ('jitter','sandra_softphone')
      and nullif(btrim(c.jitter_session_id),'') is not null and nullif(btrim(c.jitter_attempt_id),'') is not null
);
end;
$$;
revoke all on function public.fn_recording_library_sources(uuid,text) from public,anon,authenticated;
grant execute on function public.fn_recording_library_sources(uuid,text) to service_role;

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
      coalesce(proof.recording_status,c.recording_status) as recording_status, c.id as call_id,
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
revoke all on function public.recording_library_rows(uuid,text,jsonb) from public,anon,authenticated,service_role;

commit;
