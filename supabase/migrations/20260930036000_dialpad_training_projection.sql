begin;

-- Preserve all training isolation rules while permitting signed Dialpad calls.
alter table public.call_activities drop constraint training_call_is_unlinked;
alter table public.call_activities add constraint training_call_is_unlinked check (
  call_purpose <> 'internal_training' or (
    provider in ('sandra_softphone', 'dialpad') and property_id is null and contact_id is null
    and dialer_batch_item_id is null and not do_not_call_requested and disposition is null
  )
);

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

commit;
