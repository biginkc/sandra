-- Make recording accountability match the acquisition workflow policy.
begin;

create or replace function public.fn_get_acquisition_kpis(p_org_id uuid,p_member_id uuid,p_start timestamptz,p_end timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_at timestamptz:=statement_timestamp();
  v_today_start timestamptz := date_trunc('day', v_at at time zone 'America/Chicago') at time zone 'America/Chicago';
  v_attempts bigint; v_reached bigint; v_pending bigint; v_offers bigint; v_last timestamptz;
  v_contact bigint; v_needs_offer bigint; v_overdue bigint;
  v_missing bigint; v_recording_unknown bigint; v_talk_samples bigint; v_talk_unknown bigint;
  v_talk_average double precision; v_long bigint;
  v_properties uuid[]; v_stale bigint;
  v_samples bigint; v_first_pending bigint; v_first_seconds double precision;
  v_due bigint; v_held bigint; v_unattributed bigint;
begin
  perform public.my_leads_require_read_scope(p_org_id,p_member_id);
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_end<=p_start then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select count(*),count(*) filter(where outcome='reached'),count(*) filter(where outcome is null)
    into v_attempts,v_reached,v_pending from public.acquisition_attempts
    where org_id=p_org_id and actor_user_id=p_member_id and occurred_at>=p_start and occurred_at<p_end;
  select max(occurred_at) into v_last from public.acquisition_attempts
    where org_id=p_org_id and actor_user_id=p_member_id and attempt_kind='call'
      and occurred_at>=v_today_start and occurred_at<=v_at;
  select count(*) into v_offers from public.acquisition_offers
    where org_id=p_org_id and actor_user_id=p_member_id and sent_at>=p_start and sent_at<p_end;

  -- Inventory is current and complete; neither daily bounds nor list filters apply.
  with queue as materialized (select * from public.my_leads_queue_rows(p_org_id,p_member_id,v_at))
  select count(*) filter(where q.stage='needs_offer'),
    count(*) filter(where q.stage='contacted' and not exists(
      select 1 from public.tasks t where t.org_id=p_org_id and t.related_property_id=q.property_id
        and t.type='appointment' and t.status in ('open','snoozed')
        and greatest(t.due_at,case when t.status='snoozed' then t.snoozed_until end)>v_at))
    ,array_agg(q.property_id),count(*) filter(where q.warning_rank>0)
    into v_needs_offer,v_contact,v_properties,v_stale from queue q;
  -- Actionable work belongs to today's task assignee, not immutable booking credit.
  -- Match appointment lifecycle: original due time remains overdue when snoozed.
  select count(*) into v_overdue from public.tasks t
    where t.org_id=p_org_id and t.assignee_id=p_member_id and t.related_property_id is not null
      and t.type='appointment' and t.status in ('open','snoozed') and t.due_at<=v_at
      and t.related_property_id=any(v_properties);

  select
    count(*) filter(where coalesce(c.provider_ended_at,c.ended_at,c.started_at,a.occurred_at)<=v_at-interval '5 minutes'
      and nullif(btrim(c.recording_path),'') is null and nullif(btrim(a.recording_url),'') is null
      and not exists(select 1 from public.call_recordings r where r.call_activity_id=c.id
        and r.status='available' and nullif(btrim(r.storage_path),'') is not null)),
    count(*) filter(where false),
    count(*) filter(where a.outcome='reached' and c.talk_duration_seconds is not null),
    count(*) filter(where a.outcome='reached' and c.talk_duration_seconds is null),
    avg(c.talk_duration_seconds) filter(where a.outcome='reached' and c.talk_duration_seconds is not null),
    count(*) filter(where a.outcome='reached' and c.talk_duration_seconds>300)
    into v_missing,v_recording_unknown,v_talk_samples,v_talk_unknown,v_talk_average,v_long
    from public.acquisition_attempts a
    left join public.call_activities c on c.id=a.call_activity_id and c.org_id=a.org_id and c.property_id=a.property_id
    where a.org_id=p_org_id and a.actor_user_id=p_member_id and a.attempt_kind='call'
      and a.occurred_at>=p_start and a.occurred_at<p_end;
  -- Preserve old consumers while the additive migration precedes the UI deploy.
  select count(*) filter(where first_call_started_at is not null),count(*) filter(where first_call_started_at is null),
    avg(extract(epoch from (first_call_started_at-assigned_at))) filter(where first_call_started_at is not null)
    into v_samples,v_first_pending,v_first_seconds from public.acquisition_assignment_episodes
    where org_id=p_org_id and assignee_user_id=p_member_id and eligible and episode_kind='live'
      and assigned_at>=p_start and assigned_at<p_end;
  select count(*),count(*) filter(where t.outcome='held') into v_due,v_held
    from public.tasks t join public.acquisition_appointment_attribution a on a.task_id=t.id and a.org_id=t.org_id
    where t.org_id=p_org_id and a.accountable_user_id=p_member_id and t.type='appointment' and t.related_property_id is not null
      and t.status<>'cancelled' and t.outcome is distinct from 'rescheduled' and t.due_at>=p_start and t.due_at<p_end;
  select count(*) into v_unattributed from public.tasks t
    where t.org_id=p_org_id and t.type='appointment' and t.related_property_id is not null
      and t.status<>'cancelled' and t.outcome is distinct from 'rescheduled' and t.due_at>=p_start and t.due_at<p_end
      and not exists(select 1 from public.acquisition_appointment_attribution a where a.task_id=t.id and a.org_id=t.org_id);
  return jsonb_build_object('firstCallSamples',v_samples,'firstCallPending',v_first_pending,
    'firstCallElapsedSeconds',v_first_seconds,'appointmentsDue',v_due,'appointmentsHeld',v_held,
    'orgAppointmentsUnattributed',v_unattributed,'staleLeads',v_stale,'attempts',v_attempts,'reached',v_reached,'pendingOutcomes',v_pending,
    'offersSent',v_offers,'contactWithoutFollowUp',v_contact,'needsOffers',v_needs_offer,
    'appointmentsOverdue',v_overdue,'lastAttemptAt',v_last,'lastAttemptClockVersion',1,'asOf',v_at,
    'missingRecordings',v_missing,'recordingExpectationUnknown',v_recording_unknown,
    'averageTalkSeconds',v_talk_average,'talkTimeSamples',v_talk_samples,'talkTimeUnknown',v_talk_unknown,
    'conversationsOverFiveMinutes',v_long);
end;
$$;

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
      case when proof.actor_id is not null and ((c.operator_user_id is not null and c.operator_user_id is distinct from proof.actor_id)
        or (a.actor_user_id is not null and a.actor_user_id is distinct from proof.actor_id))
        then null else coalesce(proof.actor_id,c.operator_user_id,a.actor_user_id) end as actor_id,
      coalesce(c.operator_user_id<>a.actor_user_id,false)
        or (proof.actor_id is not null and ((c.operator_user_id is not null and c.operator_user_id<>proof.actor_id)
          or (a.actor_user_id is not null and a.actor_user_id<>proof.actor_id))) as conflicting,
      c.provider as source,coalesce(nullif(c.disposition,''),c.outcome,'unknown') as outcome,
      c.direction,c.call_purpose as purpose,c.contact_id,c.property_id,c.phone_e164 as phone,
      c.transcript_status='available' as transcript,c.summary_status='available' as summary,
      c.recording_status, c.id as call_id,
      c.jitter_attempt_id as attempt_key,c.jitter_session_id as scope_key,
      a.id as reference_id,a.recording_url as reference_url
    from public.call_activities c
    left join lateral (select (b->>'actorId')::uuid as actor_id from jsonb_array_elements(p_audio) b where b->>'id'=c.id::text) proof on true
    left join public.acquisition_attempts a on a.org_id=c.org_id and a.call_activity_id=c.id
    where c.org_id='00000000-0000-0000-0000-000000000bbb'

    union all
    select 'attempt:'||a.id::text,a.occurred_at,a.actor_user_id,false,a.source,
      coalesce(a.outcome,'unknown'),'unknown','unknown',null,a.property_id,null,false,false,
      'external',null,null,null,a.id,a.recording_url
    from public.acquisition_attempts a
    where a.org_id='00000000-0000-0000-0000-000000000bbb' and a.call_activity_id is null
      and a.attempt_kind='call' and a.source='dialpad'
  ), scoped as (
    select c.* from calls c where p_scope='owner' or (c.actor_id=p_actor and not c.conflicting)
  ), with_files as (
    select c.*,coalesce(f.files,'[]'::jsonb) as files from scoped c
    left join lateral (
      select jsonb_agg(x.file order by x.file->>'id') as files from (
        select jsonb_build_object('id','jitter:'||c.call_id::text||':'||(j->>'id'),'duration',j->'duration',
          'status',j->>'status','kind','stored','recordingId',j->>'id',
          'attemptKey',c.attempt_key,'scopeKey',c.scope_key) as file
        from jsonb_array_elements(coalesce((select b->'files' from jsonb_array_elements(p_audio) b where b->>'id'=c.call_id::text),'[]')) j
        union all
        select jsonb_build_object('id','recording:'||r.id::text,'duration',r.duration_seconds,
          'status',case when r.status='available' and nullif(btrim(r.storage_path),'') is null then 'missing'
            when r.status='available' and (c.source not in ('jitter','sandra_softphone') or nullif(btrim(c.scope_key),'') is null or nullif(btrim(c.attempt_key),'') is null) then 'external'
            when r.status='available' then 'external' else r.status end,
          'kind','stored','storagePath',r.storage_path,'attemptKey',c.attempt_key,'scopeKey',c.scope_key) as file
        from public.call_recordings r where r.call_activity_id=c.call_id
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
    case when jsonb_array_length(c.files)=0 then case when c.recording_status in ('pending','failed') then c.recording_status else 'missing' end
      when (select count(distinct e->>'status') from jsonb_array_elements(c.files) e)>1 then 'partial'
      else c.files->0->>'status' end,
    c.files
  from with_files c
  left join auth.users u on u.id=c.actor_id
  left join public.memberships m on m.user_id=c.actor_id and m.org_id='00000000-0000-0000-0000-000000000bbb'
  left join public.properties p on p.id=c.property_id and p.org_id='00000000-0000-0000-0000-000000000bbb'
  left join public.contacts ct on ct.id=c.contact_id and ct.org_id='00000000-0000-0000-0000-000000000bbb'
  where c.call_id is null or c.recording_status<>'none' or jsonb_array_length(c.files)>0
    or (c.source='sandra_softphone' and c.at<=statement_timestamp()-interval '5 minutes');
end;
$$;

create or replace function public.fn_log_acquisition_attempt(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_attempt uuid; v_org uuid; v_episode uuid; v_actor uuid:=auth.uid(); v_obligation uuid;
begin
  if p_input->>'source'='dialpad' and nullif(btrim(p_input->>'recordingUrl'),'') is null then
    raise exception 'RECORDING_REQUIRED' using errcode='22023';
  end if;
  v_result:=public.fn_log_acquisition_attempt_without_sms_obligation(p_input);
  if coalesce((v_result->>'duplicate')::boolean,false) then
    v_attempt:=(v_result->>'attemptId')::uuid;
    v_org:=(p_input->>'orgId')::uuid;
    select o.id into v_obligation from public.rep_sms_obligations o
      where o.org_id=v_org and o.attempt_id=v_attempt and o.obligation_kind='no_answer_sms';
    return jsonb_set(v_result,'{obligationId}',coalesce(to_jsonb(v_obligation),'null'::jsonb),true);
  end if;
  if p_input->>'outcome'='no_answer' then
    v_attempt:=(v_result->>'attemptId')::uuid;
    v_org:=(select p.org_id from public.properties p where p.id=(p_input->>'propertyId')::uuid);
    v_episode:=(v_result->>'assignmentEpisodeId')::uuid;
    v_obligation:=public.fn_ensure_rep_sms_no_answer_obligation(v_org,(p_input->>'propertyId')::uuid,v_episode,v_attempt,
      v_actor,(p_input->>'occurredAt')::timestamptz,p_input);
    v_result:=jsonb_set(v_result,'{obligationId}',coalesce(to_jsonb(v_obligation),'null'::jsonb),true);
  end if;
  return v_result;
end;
$$;

revoke all on function public.fn_log_acquisition_attempt(jsonb) from public,anon,service_role;
grant execute on function public.fn_log_acquisition_attempt(jsonb) to authenticated;

comment on function public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz) is
  'Counts every completed call attempt without attached audio as missing after five minutes; recording policy is known for Sandra and DialPad acquisition calls.';
comment on function public.recording_library_rows(uuid,text,jsonb) is
  'Includes missing Sandra artifacts and DialPad attempts without links so owners can audit recording compliance.';

commit;
