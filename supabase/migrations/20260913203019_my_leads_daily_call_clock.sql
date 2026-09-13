-- The daily clock uses actual calls today, independently of report date filters.
-- Version the evidence so new clients do not trust the historical RPC during rollout.
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
    count(*) filter(where c.recording_expected is true and coalesce(c.provider_ended_at,c.ended_at)<=v_at-interval '5 minutes'
      and nullif(btrim(c.recording_path),'') is null and nullif(btrim(a.recording_url),'') is null
      and not exists(select 1 from public.call_recordings r where r.call_activity_id=c.id
        and r.status='available' and nullif(btrim(r.storage_path),'') is not null)),
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
    'appointmentsOverdue',v_overdue,'lastAttemptAt',v_last,'lastAttemptClockVersion',1,'asOf',v_at,
    'missingRecordings',v_missing,'recordingExpectationUnknown',v_recording_unknown,
    'averageTalkSeconds',v_talk_average,'talkTimeSamples',v_talk_samples,'talkTimeUnknown',v_talk_unknown,
    'conversationsOverFiveMinutes',v_long);
end;
$$;
revoke all on function public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz) to authenticated;
commit;
