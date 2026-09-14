-- Rep-selected outcomes are authoritative; transport answers are not conversations.
begin;
alter table public.call_activities
  add column talk_duration_seconds integer check (talk_duration_seconds >= 0),
  add column recording_expected boolean,
  add column provider_ended_at timestamptz;
comment on column public.call_activities.talk_duration_seconds is 'Measured seller talk seconds, excluding dialing/ringing; NULL means unavailable. Never infer from total call duration.';
comment on column public.call_activities.provider_ended_at is 'Authoritative terminal provider timestamp, independent of browser wrap-up edits; NULL means unavailable.';
comment on column public.call_activities.recording_expected is 'Provider evidence that recording was expected; NULL means unavailable, not false.';

-- Undo only outcomes inferred by the former reconciliation function. Explicit
-- finalization receipts retain the rep selection. No duration/expectation backfill.
update public.acquisition_attempts a set outcome=null
where a.source='sandra' and a.outcome is not null
  and not exists(select 1 from public.acquisition_commands r
    where r.org_id=a.org_id and r.operation='finalize_acquisition_attempt'
      and r.result->>'attemptId'=a.id::text);

create or replace function public.my_leads_reconcile_call(p_org uuid,p_jitter_id text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_jitter_id is null or p_jitter_id='' then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text||':acquisition-finalize:'||p_jitter_id,0));
  update public.acquisition_attempts a set
    call_activity_id=c.id,
    note=coalesce(a.note,nullif(btrim(c.notes),''))
  from public.acquisition_commands r,public.call_activities c
  where r.org_id=p_org and r.operation='record_call_start' and r.result->>'jitterCallId'=p_jitter_id
    and a.command_id=r.id and a.org_id=p_org and a.source='sandra'
    and c.org_id=p_org and c.property_id=a.property_id and c.provider='sandra_softphone'
    and c.jitter_attempt_id='sandra-'||p_jitter_id
    and c.operator_user_id=a.actor_user_id
    and c.provider_call_id=r.result->>'sellerProviderCallId'
    and (a.call_activity_id is null or a.call_activity_id=c.id);
end;
$$;
revoke all on function public.my_leads_reconcile_call(uuid,text) from public,anon,authenticated,service_role;

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
    and property_id=(p_input->>'propertyId')::uuid and source='sandra' and actor_user_id=v_actor for update;
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

-- Existing browser column grants must not turn telemetry into editable claims.
create or replace function public.my_leads_guard_call_metrics()
returns trigger language plpgsql set search_path='' as $$
begin
  if current_user not in ('postgres','service_role','supabase_admin') and
    ((tg_op='INSERT' and (new.talk_duration_seconds is not null or new.recording_expected is not null or new.provider_ended_at is not null))
      or (tg_op='UPDATE' and (new.talk_duration_seconds is distinct from old.talk_duration_seconds
        or new.recording_expected is distinct from old.recording_expected
        or new.provider_ended_at is distinct from old.provider_ended_at))) then
    raise exception 'PROVIDER_EVIDENCE_READ_ONLY' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function public.my_leads_guard_call_metrics() from public,anon,authenticated;
create trigger acquisition_call_metrics_guard before insert or update on public.call_activities
  for each row execute function public.my_leads_guard_call_metrics();

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
    'appointmentsOverdue',v_overdue,'lastAttemptAt',v_last,'asOf',v_at,
    'missingRecordings',v_missing,'recordingExpectationUnknown',v_recording_unknown,
    'averageTalkSeconds',v_talk_average,'talkTimeSamples',v_talk_samples,'talkTimeUnknown',v_talk_unknown,
    'conversationsOverFiveMinutes',v_long);
end;
$$;
revoke all on function public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz) to authenticated;
commit;
