-- Internal KPI evidence gate. No browser/service-role EXECUTE grant: the existing
-- authorized KPI definer calls this as its owner. Inbox writes are server-only
-- and authenticated by the voice receiver; do not accept browser manifests.
begin;
create index dialpad_recording_manifest_lookup_idx
  on public.dialpad_voice_event_inbox(org_id,(payload->>'call_id'))
  where payload->>'state'='recording';

create function public.dialpad_has_complete_owned_recording(p_org uuid,p_call text)
returns boolean language sql stable security invoker set search_path='' as $$
  with manifests as materialized (
    select e.payload->'recording_details' as details
    from public.dialpad_voice_event_inbox e
    join public.dialpad_voice_intents i on i.org_id=e.org_id and i.provider_call_id=p_call
    where e.org_id=p_org and e.payload->>'call_id'=p_call
      and e.payload->>'state'='recording'
      -- An early readiness event may omit details; later enrichment can supply
      -- the complete manifest. Empty/missing lists never prove completeness.
      and case when jsonb_typeof(e.payload->'recording_details')='array'
        then jsonb_array_length(e.payload->'recording_details')>0 else false end
      and lower(e.payload#>>'{target,type}')='user'
      and e.payload#>>'{target,id}'=i.dialpad_user_id
      and e.payload->>'direction'='outbound'
      and e.payload->>'custom_data'=i.id::text
      and e.payload->>'internal_number'=i.caller_id_e164
      and e.payload->>'external_number'=i.destination_e164
  ), segments as materialized (
    select segment from manifests m cross join lateral
      jsonb_array_elements(case when jsonb_typeof(m.details)='array' then m.details else '[]'::jsonb end) segment
  ), known_ids as (
    select segment->>'id' as id from segments
    union
    select provider_recording_id from public.dialpad_recording_artifacts where org_id=p_org and provider_call_id=p_call
  )
  select exists(select 1 from manifests)
    and not exists(select 1 from segments where jsonb_typeof(segment)<>'object'
      or coalesce(jsonb_typeof(segment->'id'),'null') not in ('string','number')
      or nullif(btrim(segment->>'id'),'') is null)
    and exists(select 1 from known_ids)
    and not exists(
      select 1 from known_ids k where not exists(
        select 1 from public.dialpad_recording_artifacts a
        join storage.buckets b on b.id=a.storage_bucket and b.public is false
        where a.org_id=p_org and a.provider_call_id=p_call and a.provider_recording_id=k.id
          and a.status='available' and a.verified_at is not null and isfinite(a.verified_at)
          and a.byte_count>0 and a.decoded_duration_seconds>0
          and a.decoded_duration_seconds<'Infinity'::numeric
          and a.content_sha256 ~ '^[0-9a-f]{64}$'
          and a.media_type in ('audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/wave','audio/ogg','application/ogg','audio/flac','audio/x-flac')
          and a.storage_path in (
            p_org::text||'/'||p_call||'/'||a.id::text||'/'||a.content_sha256||'.mp3',
            p_org::text||'/'||p_call||'/'||a.id::text||'/'||a.content_sha256||'.wav',
            p_org::text||'/'||p_call||'/'||a.id::text||'/'||a.content_sha256||'.ogg',
            p_org::text||'/'||p_call||'/'||a.id::text||'/'||a.content_sha256||'.flac')
      )
    );
$$;
revoke all on function public.dialpad_has_complete_owned_recording(uuid,text) from public,anon,authenticated,service_role;

create or replace function public.fn_get_acquisition_kpis(p_org_id uuid,p_member_id uuid,p_start timestamptz,p_end timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_at timestamptz:=statement_timestamp();
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
    where org_id=p_org_id and actor_user_id=p_member_id and occurred_at<=v_at;
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
    count(*) filter(where c.recording_expected is true and coalesce(c.provider_ended_at,c.ended_at)<=v_at-interval '5 minutes'
      and case when c.provider='dialpad' then
        not public.dialpad_has_complete_owned_recording(c.org_id,c.provider_call_id)
      else nullif(btrim(c.recording_path),'') is null and nullif(btrim(a.recording_url),'') is null
        and not exists(select 1 from public.call_recordings r where r.call_activity_id=c.id
          and r.status='available' and nullif(btrim(r.storage_path),'') is not null) end),
    count(*) filter(where c.recording_expected is null),
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
    'appointmentsOverdue',v_overdue,'lastAttemptAt',v_last,'asOf',v_at,
    'missingRecordings',v_missing,'recordingExpectationUnknown',v_recording_unknown,
    'averageTalkSeconds',v_talk_average,'talkTimeSamples',v_talk_samples,'talkTimeUnknown',v_talk_unknown,
    'conversationsOverFiveMinutes',v_long);
end;
$$;
revoke all on function public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz) to authenticated;
commit;
