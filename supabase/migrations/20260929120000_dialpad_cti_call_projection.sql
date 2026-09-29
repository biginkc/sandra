-- ============================================================================
-- Migration: Dialpad CTI call lifecycle projection (A3)
-- Purpose: turn signature-verified inbox events (A1 dialpad_call_events) into
-- the existing ledger, idempotently and independent of arrival order:
--   * one call_activities row (provider 'dialpad') per prepared intent,
--   * one acquisition_attempts row (source 'dialpad') per prepared intent,
--   * transfer legs (new call_id, master_call_id -> original call) link to the
--     ORIGINATING intent and never create a second attempt,
--   * provider-reported connected time lands in talk_duration_seconds only;
--     seller_speech_* is never written here, so it can never earn KPI credit.
--
-- Attribution is read only from the frozen intent (rep, lead, episode,
-- destination), never from the rep's current binding or assignment. There is no
-- phone-number-only fallback: an event needs the intent's custom_data, an
-- already-matched call id, or a master_call_id naming an already-matched call.
--
-- Rep-selected outcomes stay authoritative: a CTI attempt is created pending
-- (outcome null) and the existing finalize path completes it, exactly as for
-- Sandra softphone attempts. Softphone and Jitter behaviour is unchanged.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Inbox processing markers
-- ----------------------------------------------------------------------------

alter table public.dialpad_call_events add column if not exists projected_at timestamptz;
alter table public.dialpad_call_events add column if not exists process_attempts smallint not null default 0;
alter table public.dialpad_call_events add column if not exists last_process_error text;

alter table public.dialpad_call_events drop constraint if exists dialpad_call_events_process_error_check;
alter table public.dialpad_call_events add constraint dialpad_call_events_process_error_check
  check (last_process_error is null or length(last_process_error) between 1 and 32);

create index if not exists dialpad_call_events_pending_idx
  on public.dialpad_call_events (received_at)
  where disposition = 'received' or (disposition = 'matched' and projected_at is null);

comment on column public.dialpad_call_events.projected_at is
  'Set once the matched event has been folded into call_activities/acquisition_attempts. Null on a matched event means projection still owed (the sweep re-drives it).';
comment on column public.dialpad_call_events.process_attempts is
  'Failed processing attempts recorded by the sweep; events at 10 are left for operator review instead of being retried forever.';

create or replace function public.dialpad_cti_guard_event()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_mutable constant text[] := array['disposition', 'disposition_reason', 'matched_intent_id', 'disposed_at',
    'projected_at', 'process_attempts', 'last_process_error'];
  v_bookkeeping constant text[] := array['projected_at', 'process_attempts', 'last_process_error'];
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad_call_events are a durable inbox and cannot be deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.disposition not in ('received', 'conflict') or new.matched_intent_id is not null
       or new.projected_at is not null or new.process_attempts <> 0 or new.last_process_error is not null then
      raise exception 'an inbox event must be inserted received or conflict' using errcode = '42501';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_mutable) <> (to_jsonb(old) - v_mutable) then
    raise exception 'inbox event evidence is immutable' using errcode = '42501';
  end if;
  if old.projected_at is not null and new.projected_at is distinct from old.projected_at then
    raise exception 'projected_at is forward only' using errcode = '42501';
  end if;
  if old.disposition in ('matched', 'conflict')
     and (to_jsonb(new) - v_bookkeeping) <> (to_jsonb(old) - v_bookkeeping) then
    raise exception 'a % inbox event is terminal', old.disposition using errcode = '42501';
  end if;
  if new.disposition = 'received' and old.disposition <> 'received' then
    raise exception 'an inbox event cannot return to received' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Ledger constraints (additive: the new predicates are supersets of the old)
-- ----------------------------------------------------------------------------

create unique index if not exists idx_call_activities_org_dialpad_cti_attempt
  on public.call_activities (org_id, jitter_attempt_id)
  where provider = 'dialpad' and jitter_attempt_id like 'dialpad-cti:%';
create unique index if not exists idx_call_activities_org_dialpad_cti_call
  on public.call_activities (org_id, provider_call_id)
  where provider = 'dialpad' and jitter_attempt_id like 'dialpad-cti:%' and provider_call_id is not null;

alter table public.acquisition_attempts drop constraint if exists acquisition_attempts_pending_outcome_check;
alter table public.acquisition_attempts add constraint acquisition_attempts_pending_outcome_check
  check (
    source = 'sandra'
    or outcome is not null
    or (source = 'dialpad' and coalesce(provider_attempt_key like 'dialpad-cti:%', false))
  );

-- ----------------------------------------------------------------------------
-- Internal helpers (not callable by API roles)
-- ----------------------------------------------------------------------------

create or replace function public.dialpad_cti_payload_ms(p_payload jsonb, p_field text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when (p_payload ->> p_field) ~ '^[0-9]{13,14}$' then (p_payload ->> p_field)::bigint end;
$$;

create or replace function public.dialpad_cti_chain_root(p_provider_call_id text, p_payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when (p_payload ->> 'master_call_id') ~ '^[1-9][0-9]{0,19}$'
    then p_payload ->> 'master_call_id' else p_provider_call_id end;
$$;

-- Resolves one inbox event to an intent: A1 matching first, then a transfer
-- leg link through master_call_id. Caller holds the chain lock.
create or replace function public.dialpad_cti_resolve_event(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res jsonb;
  v_event public.dialpad_call_events%rowtype;
  v_intent public.dialpad_call_intents%rowtype;
  v_master text;
  v_custom text;
  v_reason text;
  c_skew_ms constant bigint := 5000;
begin
  v_res := public.fn_match_dialpad_call_event(p_event_id);
  if v_res ->> 'disposition' <> 'quarantined'
     or v_res ->> 'reason' not in ('no_custom_data', 'intent_already_matched', 'target_mismatch') then
    return v_res;
  end if;

  select * into v_event from public.dialpad_call_events where id = p_event_id for update;
  v_master := v_event.payload ->> 'master_call_id';
  if v_master is null or v_master !~ '^[1-9][0-9]{0,19}$' or v_master = v_event.provider_call_id then
    return v_res;
  end if;
  select * into v_intent from public.dialpad_call_intents
    where org_id = v_event.org_id and matched_provider_call_id = v_master for update;
  if not found then return v_res; end if;

  v_custom := nullif(v_event.payload ->> 'custom_data', '');
  if v_custom is not null and v_custom <> v_intent.custom_data then
    v_reason := 'unknown_custom_data';
  elsif (v_event.payload ->> 'external_number') is distinct from v_intent.destination_e164 then
    v_reason := 'number_mismatch';
  elsif v_event.event_timestamp_ms < floor(extract(epoch from v_intent.prepared_at) * 1000)::bigint - c_skew_ms then
    v_reason := 'outside_intent_window';
  end if;

  if v_reason is not null then
    update public.dialpad_call_events
      set disposition = 'quarantined', disposition_reason = v_reason, disposed_at = now()
      where id = v_event.id;
    return jsonb_build_object('eventId', v_event.id, 'disposition', 'quarantined', 'intentId', null,
      'reason', v_reason, 'replayed', false);
  end if;

  update public.dialpad_call_events
    set disposition = 'matched', disposition_reason = null, matched_intent_id = v_intent.id, disposed_at = now()
    where id = v_event.id;
  return jsonb_build_object('eventId', v_event.id, 'disposition', 'matched', 'intentId', v_intent.id,
    'reason', null, 'replayed', false, 'leg', true);
end;
$$;

-- Recomputes the whole call from every matched event (all legs), so the result
-- does not depend on arrival order and replay is a no-op. Caller holds the
-- chain lock. Writes only provider evidence columns on call_activities; rep
-- wrap-up fields, notes and the rep-selected attempt outcome are never touched.
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
    v_intent.org_id, v_intent.property_id, v_intent.contact_id, v_key, v_intent.rep_user_id, v_started, v_ended_at,
    case when v_ended then greatest(0, round((v_ended_ms - v_started_ms) / 1000.0))::integer end,
    v_outcome, 'dialpad', v_intent.matched_provider_call_id, v_events, 'outbound', v_intent.destination_e164, 'customer',
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

  update public.dialpad_call_events set projected_at = now()
    where org_id = v_intent.org_id and matched_intent_id = v_intent.id and disposition = 'matched' and projected_at is null;

  return jsonb_build_object('projected', true, 'intentId', v_intent.id, 'callActivityId', v_activity.id,
    'attemptId', v_attempt.id, 'attemptCreated', v_attempt_created, 'ended', v_ended, 'connected', v_connected,
    'legs', v_legs, 'events', v_events,
    'talkDurationSeconds', v_activity.talk_duration_seconds);
end;
$$;

-- ----------------------------------------------------------------------------
-- Service-only entry points
-- ----------------------------------------------------------------------------

-- Match (or link a transfer leg), then project. One transaction per call, so an
-- interrupted run leaves the event received or matched-unprojected and a replay
-- (inline retry or the sweep) completes it exactly once. Everything for one
-- call chain is serialized on a single advisory lock taken before any row lock.
create or replace function public.fn_process_dialpad_call_event(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_probe public.dialpad_call_events%rowtype;
  v_event public.dialpad_call_events%rowtype;
  v_root text;
  v_res jsonb;
  v_sib record;
  v_sib_res jsonb;
  v_intent_id uuid;
  v_changed boolean := false;
  v_projection jsonb := null;
begin
  select * into v_probe from public.dialpad_call_events where id = p_event_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  v_root := public.dialpad_cti_chain_root(v_probe.provider_call_id, v_probe.payload);
  perform pg_advisory_xact_lock(hashtextextended('dialpad-chain:' || v_probe.org_id::text || ':' || v_root, 0));

  select * into v_event from public.dialpad_call_events where id = p_event_id for update;
  if v_event.disposition = 'conflict' then
    return jsonb_build_object('eventId', v_event.id, 'disposition', 'conflict', 'intentId', null,
      'reason', v_event.disposition_reason, 'projected', false, 'replayed', true);
  end if;
  if v_event.disposition = 'matched' and v_event.projected_at is not null then
    return jsonb_build_object('eventId', v_event.id, 'disposition', 'matched', 'intentId', v_event.matched_intent_id,
      'reason', null, 'projected', false, 'replayed', true);
  end if;

  if v_event.disposition = 'matched' then
    v_res := jsonb_build_object('eventId', v_event.id, 'disposition', 'matched', 'intentId', v_event.matched_intent_id,
      'reason', null, 'replayed', true);
    v_changed := true;
  else
    v_res := public.dialpad_cti_resolve_event(v_event.id);
    v_changed := v_res ->> 'disposition' = 'matched';
  end if;
  v_intent_id := nullif(v_res ->> 'intentId', '')::uuid;

  if v_changed then
    -- Earlier arrivals of this same call that could not match yet. An event that
    -- was outside the intent window only because it arrived before the in-window
    -- event that binds the call (a call longer than the TTL whose hangup came
    -- first) is re-run through the full matcher: once the intent is bound to this
    -- call id the window no longer applies, while token, target and number are
    -- still checked. The window itself is never widened.
    for v_sib in
      select id from public.dialpad_call_events
        where org_id = v_event.org_id and id <> v_event.id and disposition = 'quarantined'
          and disposition_reason in ('no_custom_data', 'intent_already_matched', 'target_mismatch', 'outside_intent_window')
          and (provider_call_id = v_root or (payload ->> 'master_call_id') = v_root)
        order by event_timestamp_ms, id
    loop
      v_sib_res := public.dialpad_cti_resolve_event(v_sib.id);
    end loop;
    v_projection := public.dialpad_cti_project_intent(v_intent_id);
  end if;

  return jsonb_build_object('eventId', v_event.id, 'disposition', v_res ->> 'disposition', 'intentId', v_intent_id,
    'reason', v_res ->> 'reason', 'projected', coalesce((v_projection ->> 'projected')::boolean, false),
    'callActivityId', v_projection ->> 'callActivityId', 'attemptId', v_projection ->> 'attemptId',
    'replayed', coalesce((v_res ->> 'replayed')::boolean, false) and not coalesce((v_projection ->> 'projected')::boolean, false));
end;
$$;

create or replace function public.fn_list_dialpad_call_events_for_processing(p_limit integer default 50)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(id order by received_at, id), '{}'::uuid[])
  from (
    select id, received_at from public.dialpad_call_events
    where process_attempts < 10
      and (disposition = 'received' or (disposition = 'matched' and projected_at is null))
    order by received_at, id
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) pending;
$$;

create or replace function public.fn_record_dialpad_event_process_failure(p_event_id uuid, p_sqlstate text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.dialpad_call_events
    set process_attempts = least(process_attempts + 1, 32000),
        last_process_error = left(coalesce(nullif(regexp_replace(coalesce(p_sqlstate, ''), '[^0-9A-Za-z]', '', 'g'), ''), 'unknown'), 32)
    where id = p_event_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- Rep-selected outcomes: let CTI Dialpad attempts use the existing finalize and
-- reference lookups exactly like softphone attempts. Bodies are the live
-- definitions with the source predicate widened; nothing else changes.
-- ----------------------------------------------------------------------------

create or replace function public.fn_finalize_acquisition_attempt_without_sms_obligation(p_input jsonb)
returns jsonb
language plpgsql security definer set search_path to '' as $function$
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
    and property_id=(p_input->>'propertyId')::uuid
    and (source='sandra' or (source='dialpad' and provider_attempt_key like 'dialpad-cti:%'))
    and actor_user_id=v_actor for update;
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
$function$;

create or replace function public.fn_get_acquisition_call_references(p_org_id uuid, p_property_id uuid, p_member_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to '' as $function$
begin
  if auth.uid() is null or not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=auth.uid()
    and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  perform public.my_leads_require_read_scope(p_org_id,p_member_id);
  if not exists(select 1 from public.properties p where p.id=p_property_id and p.org_id=p_org_id
    and p.assigned_user_id=p_member_id and p.deleted_at is null) then
    raise exception 'STALE_ASSIGNMENT' using errcode='42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id',a.call_activity_id,'occurredAt',a.occurred_at) order by a.occurred_at desc),'[]')
    from (select call_activity_id,occurred_at from public.acquisition_attempts where org_id=p_org_id and property_id=p_property_id
      and actor_user_id=auth.uid()
      and (source='sandra' or (source='dialpad' and provider_attempt_key like 'dialpad-cti:%'))
      and outcome is null and call_activity_id is not null order by occurred_at desc limit 20) a);
end;
$function$;

-- ----------------------------------------------------------------------------
-- Grants (service role only; the CREATE OR REPLACE above preserves the existing
-- grants on the two widened functions)
-- ----------------------------------------------------------------------------

revoke all on function public.dialpad_cti_payload_ms(jsonb, text) from public, anon, authenticated;
revoke all on function public.dialpad_cti_chain_root(text, jsonb) from public, anon, authenticated;
revoke all on function public.dialpad_cti_resolve_event(uuid) from public, anon, authenticated;
revoke all on function public.dialpad_cti_project_intent(uuid) from public, anon, authenticated;
revoke all on function public.fn_process_dialpad_call_event(uuid) from public, anon, authenticated;
revoke all on function public.fn_list_dialpad_call_events_for_processing(integer) from public, anon, authenticated;
revoke all on function public.fn_record_dialpad_event_process_failure(uuid, text) from public, anon, authenticated;

grant execute on function public.fn_process_dialpad_call_event(uuid) to service_role;
grant execute on function public.fn_list_dialpad_call_events_for_processing(integer) to service_role;
grant execute on function public.fn_record_dialpad_event_process_failure(uuid, text) to service_role;

commit;
