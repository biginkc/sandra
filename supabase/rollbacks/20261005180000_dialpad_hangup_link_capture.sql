-- Rollback for 20261005180000_dialpad_hangup_link_capture.
-- Run the link_backfill data rollback (fn_my_leads_housekeeping_rollback, or the script's `rollback --run`)
-- for every applied link_backfill run BEFORE this: afterwards such a run can no longer be rolled back, and
-- dropping the columns discards every captured provider_* value. Links the projection copied into
-- acquisition_attempts.recording_url stay (they are ordinary attempt data); clear them by hand if unwanted.
-- Restores the live bodies verbatim: guard 20260927023443:19-37, projection 20260930036000:12-180,
-- rollback entry point and fingerprint 20261005130000.
begin;

create or replace function public.dialpad_cti_project_intent(p_intent_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.dialpad_call_intents%rowtype;
  v_key text;
  v_started_ms bigint;
  v_first_event_ms bigint;
  v_events integer;
  v_legs integer;
  v_hung_legs integer;
  v_last_transferred boolean;
  v_ended boolean := false;
  v_ended_ms bigint;
  v_connected boolean;
  v_voicemail boolean;
  v_recorded boolean;
  v_talk_ms bigint;
  v_started timestamptz;
  v_ended_at timestamptz;
  v_outcome text;
  v_activity public.call_activities%rowtype;
  v_attempt public.acquisition_attempts%rowtype;
  v_attempt_created boolean := false;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
begin
  select * into v_intent from public.dialpad_call_intents where id = p_intent_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_intent.status <> 'matched' then
    return jsonb_build_object('projected', false, 'reason', 'intent_not_matched');
  end if;
  select * into v_property from public.properties
    where id = v_intent.property_id and org_id = v_intent.org_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  v_key := 'dialpad-cti:' || v_intent.id::text;

  select count(*), count(distinct provider_call_id),
         min(public.dialpad_cti_payload_ms(payload, 'date_started')),
         min(event_timestamp_ms),
         coalesce(bool_or(event_state = 'connected' or public.dialpad_cti_payload_ms(payload, 'date_connected') is not null), false),
         coalesce(bool_or(event_state = 'voicemail'), false),
         coalesce(bool_or(payload -> 'was_recorded' = 'true'::jsonb), false)
    into v_events, v_legs, v_started_ms, v_first_event_ms, v_connected, v_voicemail, v_recorded
    from public.dialpad_call_events
    where org_id = v_intent.org_id and matched_intent_id = v_intent.id and disposition = 'matched';
  if v_events = 0 then
    return jsonb_build_object('projected', false, 'reason', 'no_matched_events');
  end if;
  v_started_ms := coalesce(v_started_ms, v_first_event_ms);
  v_started := to_timestamp(v_started_ms / 1000.0);

  -- Final hangup per leg (latest by provider timestamp). The call is over only
  -- when every leg seen has hung up and the last-ending hangup is not flagged
  -- is_transferred (that means it continues on a leg we have not seen yet).
  with h as (
    select distinct on (e.provider_call_id)
      e.provider_call_id,
      coalesce(public.dialpad_cti_payload_ms(e.payload, 'date_ended'), e.event_timestamp_ms) as ended_ms,
      e.payload -> 'is_transferred' = 'true'::jsonb as is_transferred,
      case
        when (e.payload ->> 'talk_time') ~ '^[0-9]{1,12}$' then (e.payload ->> 'talk_time')::bigint
        when public.dialpad_cti_payload_ms(e.payload, 'date_connected') is not null
             and public.dialpad_cti_payload_ms(e.payload, 'date_ended') >= public.dialpad_cti_payload_ms(e.payload, 'date_connected')
          then public.dialpad_cti_payload_ms(e.payload, 'date_ended') - public.dialpad_cti_payload_ms(e.payload, 'date_connected')
        else 0
      end as talk_ms
    from public.dialpad_call_events e
    where e.org_id = v_intent.org_id and e.matched_intent_id = v_intent.id and e.disposition = 'matched'
      and e.event_state = 'hangup'
    order by e.provider_call_id, e.event_timestamp_ms desc, e.id
  ), m as (select max(ended_ms) as mx from h)
  select count(*), (select mx from m), coalesce(sum(talk_ms), 0),
         coalesce(bool_or(is_transferred) filter (where ended_ms = (select mx from m)), false)
    into v_hung_legs, v_ended_ms, v_talk_ms, v_last_transferred
    from h;
  v_ended := v_hung_legs > 0 and v_hung_legs = v_legs and not v_last_transferred;

  if v_ended then
    v_ended_at := to_timestamp(v_ended_ms / 1000.0);
    v_outcome := case
      when v_voicemail then 'voicemail'
      when v_connected or v_talk_ms > 0 then 'unknown'
      else 'no_answer'
    end;
  end if;

  insert into public.call_activities (
    org_id, property_id, contact_id, jitter_attempt_id, operator_user_id, started_at, ended_at, duration_seconds,
    outcome, provider, provider_call_id, raw_event_count, direction, phone_e164, call_purpose,
    talk_duration_seconds, recording_expected, provider_ended_at
  ) values (
    v_intent.org_id, case when not v_property.is_training then v_intent.property_id end,
    case when not v_property.is_training then v_intent.contact_id end, v_key, v_intent.rep_user_id, v_started, v_ended_at,
    case when v_ended then greatest(0, round((v_ended_ms - v_started_ms) / 1000.0))::integer end,
    v_outcome, 'dialpad', v_intent.matched_provider_call_id, v_events, 'outbound', v_intent.destination_e164,
    case when v_property.is_training then 'internal_training' else 'customer' end,
    case when v_ended then round(v_talk_ms / 1000.0)::integer end,
    case when v_ended then v_recorded end, v_ended_at
  )
  on conflict (org_id, jitter_attempt_id) where provider = 'dialpad' and jitter_attempt_id like 'dialpad-cti:%'
  do update set
    started_at = excluded.started_at, ended_at = excluded.ended_at, duration_seconds = excluded.duration_seconds,
    outcome = excluded.outcome, raw_event_count = excluded.raw_event_count,
    talk_duration_seconds = excluded.talk_duration_seconds, recording_expected = excluded.recording_expected,
    provider_ended_at = excluded.provider_ended_at
  returning * into v_activity;

  -- Training keeps the frozen intent for attribution, never the customer ledger.
  if not v_property.is_training then
    insert into public.acquisition_attempts (
      org_id, property_id, assignment_episode_id, actor_user_id, attempt_kind, source, occurred_at,
      call_activity_id, provider_attempt_key, idempotency_key
    ) values (
      v_intent.org_id, v_intent.property_id, v_intent.assignment_episode_id, v_intent.rep_user_id, 'call', 'dialpad',
      v_started, v_activity.id, v_key, extensions.gen_random_uuid()
    )
    on conflict (org_id, source, provider_attempt_key) where provider_attempt_key is not null do nothing
    returning * into v_attempt;
    if found then
      v_attempt_created := true;
    else
      update public.acquisition_attempts
        set occurred_at = least(occurred_at, v_started), call_activity_id = coalesce(call_activity_id, v_activity.id)
        where org_id = v_intent.org_id and source = 'dialpad' and provider_attempt_key = v_key
        returning * into v_attempt;
    end if;

    -- Same ledger effects as a Sandra softphone call start, from frozen intent
    -- attribution. The first-call clock only moves earlier; queue and property
    -- state are touched only when the attempt is first created so a replay can
    -- never undo a rep's later change.
    select * into v_property from public.properties where id = v_intent.property_id and org_id = v_intent.org_id for update;
    select * into v_queue from public.acquisition_queue_states
      where property_id = v_intent.property_id and org_id = v_intent.org_id for update;
    select * into v_episode from public.acquisition_assignment_episodes
      where id = v_intent.assignment_episode_id and property_id = v_intent.property_id and org_id = v_intent.org_id for update;
    if v_episode.eligible and v_episode.assignee_user_id = v_intent.rep_user_id and v_started >= v_episode.assigned_at
       and (v_episode.ended_at is null or v_started < v_episode.ended_at) then
      update public.acquisition_assignment_episodes
        set first_call_started_at = v_started, first_call_actor_user_id = v_intent.rep_user_id, first_call_provider_key = v_key
        where id = v_episode.id and (first_call_started_at is null or first_call_started_at > v_started);
    end if;
    if v_attempt_created and v_episode.ended_at is null and v_episode.assignee_user_id = v_property.assigned_user_id
       and v_started >= coalesce(v_episode.assigned_at, v_episode.initialized_at)
       and v_queue.archived_at is null and v_property.deleted_at is null and not coalesce(v_property.is_dnc_locked, false)
       and v_property.status::text not in ('closed', 'dead', 'dnc')
       and exists (select 1 from public.acquisition_org_settings where org_id = v_intent.org_id and my_leads_enabled) then
      if v_queue.property_id is null then
        insert into public.acquisition_queue_states (property_id, org_id, stage, stage_entered_at, version)
          values (v_intent.property_id, v_intent.org_id, 'contacted', v_started, 1);
      end if;
      if v_property.status::text in ('prospect', 'new_lead') then
        update public.properties set status = 'contacted' where id = v_intent.property_id and org_id = v_intent.org_id;
      end if;
    end if;

  end if;

  update public.dialpad_call_events set projected_at = now()
    where org_id = v_intent.org_id and matched_intent_id = v_intent.id and disposition = 'matched' and projected_at is null;

  return jsonb_build_object('projected', true, 'intentId', v_intent.id, 'callActivityId', v_activity.id,
    'attemptId', v_attempt.id, 'attemptCreated', v_attempt_created, 'ended', v_ended, 'connected', v_connected,
    'legs', v_legs, 'events', v_events,
    'talkDurationSeconds', v_activity.talk_duration_seconds);
end;
$$;

create or replace function public.my_leads_guard_call_metrics()
returns trigger language plpgsql set search_path='' as $$
begin
  if current_user not in ('postgres','service_role','supabase_admin') and
    ((tg_op='INSERT' and (new.talk_duration_seconds is not null or new.recording_expected is not null or new.provider_ended_at is not null
      or new.seller_speech_seconds_measured is not null or new.seller_speech_seconds_estimated is not null
      or new.seller_speech_confidence is not null))
      or (tg_op='UPDATE' and (new.talk_duration_seconds is distinct from old.talk_duration_seconds
        or new.recording_expected is distinct from old.recording_expected
        or new.provider_ended_at is distinct from old.provider_ended_at
        or new.seller_speech_seconds_measured is distinct from old.seller_speech_seconds_measured
        or new.seller_speech_seconds_estimated is distinct from old.seller_speech_seconds_estimated
        or new.seller_speech_confidence is distinct from old.seller_speech_confidence))) then
    raise exception 'PROVIDER_EVIDENCE_READ_ONLY' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function public.my_leads_guard_call_metrics() from public,anon,authenticated;

create or replace function public.my_leads_housekeeping_rollback_fingerprint(p_run uuid, p_org_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(
    r.status || '|' || coalesce((
      select string_agg(
        b.table_name || ':' || b.row_id::text || ':' || b.before::text || ':' || coalesce(case b.table_name
          when 'properties' then (select p.assigned_user_id::text || '/' || p.updated_at::text
            from public.properties p where p.id = b.row_id and p.org_id = p_org_id)
          when 'tasks' then (select t.assignee_id::text || '/' || t.status || '/' || t.updated_at::text || '/' || t.calendar_generation::text
              || case when r.kind = 'relabel' then
                   '/' || t.type || '/' || t.mode || '/' || t.due_at::text || '/' || coalesce(t.end_at::text, '')
                   || '/' || coalesce(t.calendar_chain_id::text, '')
                   || '/' || (select count(*) from public.task_calendar_mutations m
                              where m.org_id = p_org_id and m.calendar_chain_id = t.calendar_chain_id)::text
                   || '/' || (select count(*) from public.tasks s
                              where s.org_id = p_org_id and s.calendar_chain_id = t.calendar_chain_id)::text
                 when r.kind = 'offer_follow_up_backfill' then
                   '/' || t.type || '/' || t.due_at::text || '/' || coalesce(t.calendar_chain_id::text, '')
                   || '/' || (select count(*) from public.tasks s
                              where s.org_id = p_org_id and s.calendar_chain_id = t.calendar_chain_id)::text
                   || '/' || (select count(*) from public.task_calendar_mutations m
                              where m.org_id = p_org_id and m.calendar_chain_id = t.calendar_chain_id)::text
                 else '' end
            from public.tasks t where t.id = b.row_id and t.org_id = p_org_id)
          when 'acquisition_appointment_attribution' then (select a.source || '/' || a.accountable_user_id::text || '/' || a.captured_at::text
            from public.acquisition_appointment_attribution a where a.task_id = b.row_id and a.org_id = p_org_id)
          when 'acquisition_offers' then (select coalesce(o.follow_up_calendar_chain_id::text, '') || '/' || o.outcome || '/' || o.follow_up_at::text
            from public.acquisition_offers o where o.id = b.row_id and o.org_id = p_org_id)
          when 'acquisition_attempts' then (select coalesce(a.outcome, '')
            from public.acquisition_attempts a where a.id = b.row_id and a.org_id = p_org_id)
          when 'acquisition_assignment_episodes' then (select e.eligible::text || '/' || coalesce(e.ended_at::text, '')
            from public.acquisition_assignment_episodes e where e.id = b.row_id and e.org_id = p_org_id)
        end, 'missing'),
        ',' order by b.table_name, b.row_id)
      from public.my_leads_housekeeping_before_images b where b.run_id = p_run), ''), 'utf8')), 'hex')
  from public.my_leads_housekeeping_runs r
  where r.id = p_run and r.org_id = p_org_id
$$;

create or replace function public.fn_my_leads_housekeeping_rollback(
  p_run uuid, p_org_id uuid, p_fingerprint text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.my_leads_housekeeping_runs%rowtype;
  v_target uuid;
  v_owner uuid;
  r record;
  v_cur record;
  v_old uuid;
  v_created uuid;
  v_orig uuid;
  v_work text;
  v_prior_sub text;
  v_restored int := 0;
  v_already int := 0;
  v_not_restored jsonb := '[]'::jsonb;
  v_images int;
  v_summary jsonb;
  v_flag_move text;
  v_flag_retired text;
  v_rows int;
  v_attr_src text;
  v_attr_user uuid;
  v_attr_at timestamptz;
  v_attr_img jsonb;
  v_task_img jsonb;
  v_task_id uuid;
  v_flag_close text;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null then
    raise exception 'INVALID_INPUT: org is required' using errcode = 'P0001';
  end if;
  select * into v_run from public.my_leads_housekeeping_runs
  where id = p_run and org_id = p_org_id for update;
  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
  if v_run.status = 'rolled_back' then
    return jsonb_build_object('runId', p_run, 'noop', true, 'status', 'rolled_back');
  end if;
  if p_fingerprint is null then
    raise exception 'FINGERPRINT_REQUIRED: rollback needs the fingerprint from the run info' using errcode = 'P0001';
  end if;
  -- Lock every row the rollback may touch, then recompute the fence under those locks.
  perform 1 from public.properties p
  where p.org_id = p_org_id and p.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'properties') order by p.id for update;
  perform 1 from public.acquisition_offers o
  where o.org_id = p_org_id and o.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_offers') order by o.id for update;
  perform 1 from public.tasks t
  where t.org_id = p_org_id and t.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'tasks') order by t.id for update;
  perform 1 from public.acquisition_attempts a
  where a.org_id = p_org_id and a.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_attempts') order by a.id for update;
  perform 1 from public.acquisition_appointment_attribution aa
  where aa.org_id = p_org_id and aa.task_id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_appointment_attribution') order by aa.task_id for update;
  if p_fingerprint is distinct from public.my_leads_housekeeping_rollback_fingerprint(p_run, p_org_id) then
    raise exception 'FINGERPRINT_MISMATCH: the run state changed since the preview; run a new preview' using errcode = 'P0001';
  end if;

  if v_run.kind = 'reassign' then
    v_target := (v_run.params ->> 'target')::uuid;
    v_owner := (v_run.params ->> 'owner')::uuid;

    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'properties' order by b.row_id
    loop
      begin
        select p.assigned_user_id, p.updated_at into v_cur
        from public.properties p
        where p.id = r.row_id and p.org_id = p_org_id;
        if not found then
          raise exception 'PROPERTY_MISSING' using errcode = 'P0001';
        end if;
        v_old := (r.before ->> 'assigned_user_id')::uuid;
        if v_cur.assigned_user_id is not distinct from v_old then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.assigned_user_id is distinct from v_target then
          raise exception 'REASSIGNED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.updated_at is distinct from (r.before ->> 'applied_updated_at')::timestamptz then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        select i.row_id into v_created
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_assignment_episodes'
          and i.before ->> 'op' = 'created' and i.before ->> 'property_id' = r.row_id::text;
        select i.row_id into v_orig
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_assignment_episodes'
          and i.before ->> 'op' = 'updated' and i.before ->> 'property_id' = r.row_id::text;
        if v_created is null or v_orig is null then
          raise exception 'EPISODE_IMAGE_MISSING' using errcode = 'P0001';
        end if;
        v_work := public.my_leads_housekeeping_work_since(p_org_id, r.row_id, v_created, v_run.created_at);
        if v_work is not null then
          raise exception 'WORK_RECORDED: %', v_work using errcode = 'P0001';
        end if;

        -- Observer ends the created episode and opens a throwaway one for the old owner.
        update public.properties
        set assigned_user_id = v_old, updated_at = (r.before ->> 'updated_at')::timestamptz
        where id = r.row_id and org_id = p_org_id;
        delete from public.acquisition_assignment_episodes e
        where e.org_id = p_org_id and e.property_id = r.row_id and e.ended_at is null;
        delete from public.acquisition_assignment_episodes e
        where e.id = v_created and e.org_id = p_org_id and e.property_id = r.row_id;
        update public.acquisition_assignment_episodes e
        set ended_at = null
        where e.id = v_orig and e.org_id = p_org_id and e.property_id = r.row_id;
        v_restored := v_restored + 1;
      exception when others then
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'property', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'tasks' order by b.row_id
    loop
      v_prior_sub := coalesce(current_setting('request.jwt.claim.sub', true), '');
      begin
        select t.assignee_id, t.status, t.type, t.updated_at, t.calendar_generation into v_cur
        from public.tasks t where t.id = r.row_id and t.org_id = p_org_id;
        if not found then
          raise exception 'TASK_MISSING' using errcode = 'P0001';
        end if;
        v_old := (r.before ->> 'assignee_id')::uuid;
        if v_cur.assignee_id is not distinct from v_old then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.assignee_id is distinct from v_target then
          raise exception 'ASSIGNEE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.updated_at is distinct from (r.before ->> 'applied_updated_at')::timestamptz
           or v_cur.calendar_generation is distinct from (r.before ->> 'applied_generation')::int
           or v_cur.status is distinct from (r.before ->> 'status') then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        -- A task goes back with its lead: while the lead is kept (work recorded, edited), so is the task.
        perform 1 from public.properties p
        where p.id = (r.before ->> 'property_id')::uuid and p.org_id = p_org_id
          and p.assigned_user_id is not distinct from v_target;
        if found then
          raise exception 'LEAD_NOT_RESTORED' using errcode = 'P0001';
        end if;
        if v_cur.type = 'appointment' then
          perform set_config('request.jwt.claim.sub', v_owner::text, true);
          perform public.fn_reassign_appointment(
            r.row_id, v_old, md5('rollback:' || p_run::text || r.row_id::text)::uuid);
          perform set_config('request.jwt.claim.sub', v_prior_sub, true);
        else
          update public.tasks set assignee_id = v_old, updated_at = (r.before ->> 'updated_at')::timestamptz
          where id = r.row_id and org_id = p_org_id and assignee_id = v_target;
        end if;
        v_restored := v_restored + 1;
      exception when others then
        perform set_config('request.jwt.claim.sub', v_prior_sub, true);
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'task', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

  elsif v_run.kind = 'close_attempts' then
    select count(*)::int into v_images
    from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_attempts';
    -- Only rows still carrying the housekeeping value are restored; a row changed since
    -- (e.g. a call finalised it) is reported, never overwritten.
    update public.acquisition_attempts a
    set outcome = b.before ->> 'outcome'
    from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_attempts'
      and b.row_id = a.id and a.org_id = p_org_id and a.outcome = 'not_logged';
    get diagnostics v_restored = row_count;
    if v_restored < v_images then
      select coalesce(jsonb_agg(jsonb_build_object('attempt', b.row_id, 'reason', 'outcome_changed_since')), '[]'::jsonb)
      into v_not_restored
      from public.my_leads_housekeeping_before_images b
      join public.acquisition_attempts a on a.id = b.row_id and a.org_id = p_org_id
      where b.run_id = p_run and b.table_name = 'acquisition_attempts'
        and a.outcome is distinct from (b.before ->> 'outcome');
    end if;
  elsif v_run.kind = 'relabel' then
    -- A relabeled row goes back only while it still equals what the run left: open, same
    -- type/times/chain, no calendar ledger row or successor on the chain, no work on the lead
    -- since the run, and its attribution row (when the run created one) untouched.
    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'tasks' order by b.row_id
    loop
      v_flag_move := coalesce(current_setting('sandra.allow_appointment_time_move', true), '');
      v_flag_retired := coalesce(current_setting('sandra.allow_retired_task_type', true), '');
      begin
        select t.type, t.status, t.mode, t.location, t.due_at, t.end_at, t.calendar_chain_id, t.updated_at into v_cur
        from public.tasks t where t.id = r.row_id and t.org_id = p_org_id;
        if not found then
          raise exception 'TASK_MISSING' using errcode = 'P0001';
        end if;
        if v_cur.type is not distinct from (r.before ->> 'type') and v_cur.calendar_chain_id is null then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.type <> 'appointment' then
          raise exception 'TYPE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.status <> 'open' then
          raise exception 'NOT_OPEN_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.due_at is distinct from (r.before ->> 'applied_due_at')::timestamptz
           or v_cur.end_at is distinct from (r.before ->> 'applied_end_at')::timestamptz
           or v_cur.calendar_chain_id is distinct from (r.before ->> 'applied_calendar_chain_id')::uuid then
          raise exception 'RESCHEDULED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.mode <> 'phone' or v_cur.location is not null then
          raise exception 'MODE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.task_calendar_mutations m
                   where m.org_id = p_org_id and m.calendar_chain_id = v_cur.calendar_chain_id) then
          raise exception 'CALENDAR_ACTIVITY_SINCE' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.tasks s
                   where s.org_id = p_org_id and s.calendar_chain_id = v_cur.calendar_chain_id and s.id <> r.row_id) then
          raise exception 'SUCCESSOR_EXISTS' using errcode = 'P0001';
        end if;
        if v_cur.updated_at is distinct from (r.before ->> 'applied_updated_at')::timestamptz then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        v_work := public.my_leads_housekeeping_work_since(
          p_org_id, (r.before ->> 'related_property_id')::uuid, null::uuid, v_run.created_at);
        if v_work is not null then
          raise exception 'WORK_RECORDED: %', v_work using errcode = 'P0001';
        end if;
        select i.before into v_attr_img
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_appointment_attribution'
          and i.row_id = r.row_id and i.before ->> 'op' = 'created';
        if v_attr_img is not null then
          select a.source, a.accountable_user_id, a.captured_at into v_attr_src, v_attr_user, v_attr_at
          from public.acquisition_appointment_attribution a
          where a.task_id = r.row_id and a.org_id = p_org_id;
          if found and (v_attr_src is distinct from 'relabel_2026_10'
                        or v_attr_user::text is distinct from (v_attr_img ->> 'accountable_user_id')
                        or v_attr_at is distinct from (v_attr_img ->> 'applied_captured_at')::timestamptz) then
            raise exception 'ATTRIBUTION_CHANGED_SINCE' using errcode = 'P0001';
          end if;
        end if;

        perform set_config('sandra.allow_appointment_time_move', 'on', true);
        perform set_config('sandra.allow_retired_task_type', 'on', true);
        update public.tasks
        set type = r.before ->> 'type', status = r.before ->> 'status',
            due_at = (r.before ->> 'due_at')::timestamptz,
            snoozed_until = (r.before ->> 'snoozed_until')::timestamptz,
            end_at = (r.before ->> 'end_at')::timestamptz,
            calendar_chain_id = (r.before ->> 'calendar_chain_id')::uuid,
            mode = r.before ->> 'mode',
            updated_at = (r.before ->> 'updated_at')::timestamptz
        where id = r.row_id and org_id = p_org_id and type = 'appointment' and status = 'open';
        get diagnostics v_rows = row_count;
        perform set_config('sandra.allow_appointment_time_move', v_flag_move, true);
        perform set_config('sandra.allow_retired_task_type', v_flag_retired, true);
        if v_rows <> 1 then
          raise exception 'TASK_CHANGED' using errcode = 'P0001';
        end if;
        if v_attr_img is not null then
          delete from public.acquisition_appointment_attribution a
          where a.task_id = r.row_id and a.org_id = p_org_id and a.source = 'relabel_2026_10';
        end if;
        v_restored := v_restored + 1;
      exception when others then
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'task', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

  elsif v_run.kind = 'offer_follow_up_backfill' then
    -- Per offer: the follow-up it was given goes away only while the offer is still pending on
    -- the chain the run set and the task is still exactly what the run created (open, same
    -- time, no successor, no calendar ledger row). A rescheduled, completed or offer-resolved
    -- follow-up is reported, never touched. The offer's follow_up_at was never changed.
    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'acquisition_offers' order by b.row_id
    loop
      v_flag_move := coalesce(current_setting('sandra.allow_appointment_time_move', true), '');
      begin
        select o.follow_up_calendar_chain_id, o.outcome into v_cur
        from public.acquisition_offers o where o.id = r.row_id and o.org_id = p_org_id;
        if not found then
          raise exception 'OFFER_MISSING' using errcode = 'P0001';
        end if;
        if v_cur.follow_up_calendar_chain_id is null then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.follow_up_calendar_chain_id is distinct from (r.before ->> 'applied_calendar_chain_id')::uuid then
          raise exception 'CHAIN_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.outcome <> 'pending' then
          raise exception 'OFFER_RESOLVED_SINCE' using errcode = 'P0001';
        end if;
        select i.row_id, i.before into v_task_id, v_task_img
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'tasks' and i.before ->> 'offer_id' = r.row_id::text;
        if v_task_id is null then
          raise exception 'TASK_IMAGE_MISSING' using errcode = 'P0001';
        end if;
        select t.status, t.due_at, t.mode, t.calendar_chain_id, t.calendar_generation, t.updated_at into v_cur
        from public.tasks t where t.id = v_task_id and t.org_id = p_org_id;
        if not found then
          raise exception 'TASK_MISSING' using errcode = 'P0001';
        end if;
        if v_cur.status <> 'open' then
          raise exception 'NOT_OPEN_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.due_at is distinct from (v_task_img ->> 'applied_due_at')::timestamptz
           or v_cur.calendar_chain_id is distinct from (v_task_img ->> 'applied_calendar_chain_id')::uuid then
          raise exception 'RESCHEDULED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.mode <> 'phone' then
          raise exception 'MODE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.task_calendar_mutations m
                   where m.org_id = p_org_id and m.calendar_chain_id = v_cur.calendar_chain_id) then
          raise exception 'CALENDAR_ACTIVITY_SINCE' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.tasks s
                   where s.org_id = p_org_id and s.calendar_chain_id = v_cur.calendar_chain_id and s.id <> v_task_id) then
          raise exception 'SUCCESSOR_EXISTS' using errcode = 'P0001';
        end if;
        if v_cur.calendar_generation is distinct from (v_task_img ->> 'applied_generation')::int
           or v_cur.updated_at is distinct from (v_task_img ->> 'applied_updated_at')::timestamptz then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        select i.before into v_attr_img
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_appointment_attribution'
          and i.row_id = v_task_id and i.before ->> 'op' = 'created';
        if v_attr_img is not null then
          select a.source, a.accountable_user_id, a.captured_at into v_attr_src, v_attr_user, v_attr_at
          from public.acquisition_appointment_attribution a
          where a.task_id = v_task_id and a.org_id = p_org_id;
          if found and (v_attr_src is distinct from 'offer_backfill'
                        or v_attr_user::text is distinct from (v_attr_img ->> 'accountable_user_id')
                        or v_attr_at is distinct from (v_attr_img ->> 'applied_captured_at')::timestamptz) then
            raise exception 'ATTRIBUTION_CHANGED_SINCE' using errcode = 'P0001';
          end if;
        end if;

        -- Null the pointer first (the cancel guard only blocks a chain a pending offer points at).
        update public.acquisition_offers
        set follow_up_calendar_chain_id = null
        where id = r.row_id and org_id = p_org_id and outcome = 'pending'
          and follow_up_calendar_chain_id = (r.before ->> 'applied_calendar_chain_id')::uuid;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then
          raise exception 'OFFER_CHANGED' using errcode = 'P0001';
        end if;
        perform set_config('sandra.allow_appointment_time_move', 'on', true);
        update public.tasks
        set status = 'cancelled', outcome = 'cancelled',
            calendar_generation = calendar_generation + 1, updated_at = now()
        where id = v_task_id and org_id = p_org_id and status = 'open'
          and calendar_generation = (v_task_img ->> 'applied_generation')::int;
        get diagnostics v_rows = row_count;
        perform set_config('sandra.allow_appointment_time_move', v_flag_move, true);
        if v_rows <> 1 then
          raise exception 'TASK_CHANGED' using errcode = 'P0001';
        end if;
        if v_attr_img is not null then
          delete from public.acquisition_appointment_attribution a
          where a.task_id = v_task_id and a.org_id = p_org_id and a.source = 'offer_backfill';
        end if;
        v_restored := v_restored + 1;
      exception when others then
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'offer', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

  else
    raise exception 'ROLLBACK_UNSUPPORTED: kind % has no rollback branch in this release', v_run.kind
      using errcode = 'P0001';
  end if;

  v_summary := jsonb_build_object(
    'restored', v_restored, 'alreadyRestored', v_already, 'notRestored', v_not_restored);
  if jsonb_array_length(v_not_restored) = 0 then
    update public.my_leads_housekeeping_runs
    set status = 'rolled_back', rolled_back_at = now(),
        summary = summary || jsonb_build_object('rollback', v_summary)
    where id = p_run and org_id = p_org_id;
  else
    update public.my_leads_housekeeping_runs
    set summary = summary || jsonb_build_object('rollback', v_summary)
    where id = p_run and org_id = p_org_id;
  end if;
  return jsonb_build_object('runId', p_run,
    'status', case when jsonb_array_length(v_not_restored) = 0 then 'rolled_back' else 'applied' end)
    || v_summary;
end $$;


drop function if exists public.fn_my_leads_housekeeping_link_backfill(uuid, boolean, text);
drop function if exists public.my_leads_link_backfill_candidates(uuid);
drop function if exists public.dialpad_cti_hangup_links(uuid, uuid);
alter table public.call_activities drop constraint if exists call_activities_provider_links_check;
alter table public.call_activities
  drop column if exists provider_recording_url,
  drop column if exists provider_voicemail_url,
  drop column if exists provider_voicemail_transcript;

commit;
