-- Dialpad CTI A2: transactional dispatch authorization, provider directory
-- identity configuration and webhook-derived call status.
--
-- Depends on A1 (20260929034021) and A3 (20260929120000).
--
--   * dialpad_org_connections gains the Dialpad company id and the NAME of the
--     env-held directory API key used to verify a rep's Dialpad identity. The
--     key value is never stored.
--   * dialpad_call_intents gains dispatch_authorized_at, set exactly once,
--     while the intent is still prepared. It is the at-most-once dispatch
--     token: a retry can never obtain the dial payload a second time.
--   * fn_authorize_dialpad_dispatch re-proves the frozen binding, grant,
--     assignment, phone and status/expiry in one transaction and returns the
--     dial payload once. A failed revalidation cancels the intent permanently.
--   * fn_get_dialpad_call_status derives call state only from the frozen
--     intent and the webhook-projected call_activities row; the browser never
--     reports connected.
--
-- All functions are service-role only; the server action derives org and rep
-- from the authenticated session and never from client input.

alter table public.dialpad_org_connections
  add column if not exists dialpad_company_id text,
  add column if not exists directory_api_key_ref text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dialpad_org_connections_company_id_check') then
    alter table public.dialpad_org_connections
      add constraint dialpad_org_connections_company_id_check
      check (dialpad_company_id is null or dialpad_company_id ~ '^[0-9]{1,20}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dialpad_org_connections_directory_key_ref_check') then
    alter table public.dialpad_org_connections
      add constraint dialpad_org_connections_directory_key_ref_check
      check (directory_api_key_ref is null or directory_api_key_ref ~ '^env:DIALPAD_CTI_DIRECTORY_KEY_[A-Z0-9_]{1,120}$');
  end if;
end $$;

comment on column public.dialpad_org_connections.dialpad_company_id is
  'Dialpad company id (int64 as text). A directory user must belong to this company for a rep binding to verify.';
comment on column public.dialpad_org_connections.directory_api_key_ref is
  'Name (env:DIALPAD_CTI_DIRECTORY_KEY_*) of the externally held Dialpad API key used only for read-only user directory lookups. The key value must never be written to this table.';

alter table public.dialpad_call_intents add column if not exists dispatch_authorized_at timestamptz;

comment on column public.dialpad_call_intents.dispatch_authorized_at is
  'Set once by fn_authorize_dialpad_dispatch, while the intent is prepared. A set value means the dial payload was already released; later calls return already_dispatched without a payload.';

create or replace function public.dialpad_cti_guard_intent()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_mutable constant text[] := array['status', 'matched_provider_call_id', 'matched_event_id', 'matched_at', 'cancelled_at', 'dispatch_authorized_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad_call_intents are immutable evidence' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'prepared' or new.matched_provider_call_id is not null or new.matched_event_id is not null
       or new.matched_at is not null or new.cancelled_at is not null or new.dispatch_authorized_at is not null then
      raise exception 'a call intent must be created prepared' using errcode = '42501';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_mutable) <> (to_jsonb(old) - v_mutable) then
    raise exception 'call intent attribution is immutable' using errcode = '42501';
  end if;
  if old.status <> 'prepared' and new is distinct from old then
    raise exception 'a % call intent is terminal', old.status using errcode = '42501';
  end if;
  if new.dispatch_authorized_at is distinct from old.dispatch_authorized_at
     and (old.dispatch_authorized_at is not null or new.dispatch_authorized_at is null or new.status <> 'prepared') then
    raise exception 'dispatch authorization is set once, while the intent is prepared' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Dispatch authorization
-- ----------------------------------------------------------------------------
-- Lock order matches fn_prepare_dialpad_call_intent and the revoke functions:
-- binding, then grant, then property/episode, then the intent row last. A
-- concurrent revoke either commits first (the re-read below denies) or waits
-- and then cancels the intent this call has just authorized.
--
-- Returns jsonb with status:
--   authorized          first release; carries the dial payload
--   already_dispatched  a prior call released the payload; no payload
--   denied              a frozen fact no longer holds; the intent is now cancelled
--   cancelled | matched | expired   intent state; no payload
create or replace function public.fn_authorize_dialpad_dispatch(
  p_org_id uuid, p_rep_user_id uuid, p_intent_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pre public.dialpad_call_intents%rowtype;
  v_intent public.dialpad_call_intents%rowtype;
  v_conn public.dialpad_org_connections%rowtype;
  v_binding public.dialpad_member_bindings%rowtype;
  v_grant public.dialpad_number_grants%rowtype;
  v_property public.properties%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_contact public.contacts%rowtype;
  v_raw text;
  v_denial text;
begin
  if p_org_id is null or p_rep_user_id is null or p_intent_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  -- Frozen identity is immutable, so this unlocked read only decides which
  -- rows to lock, in the canonical order.
  select * into v_pre from public.dialpad_call_intents
    where id = p_intent_id and org_id = p_org_id and rep_user_id = p_rep_user_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  select * into v_binding from public.dialpad_member_bindings
    where id = v_pre.binding_id and org_id = p_org_id for share;
  if v_pre.number_grant_id is not null then
    select * into v_grant from public.dialpad_number_grants
      where id = v_pre.number_grant_id and org_id = p_org_id for share;
  end if;
  select * into v_property from public.properties where id = v_pre.property_id and org_id = p_org_id for share;
  select * into v_episode from public.acquisition_assignment_episodes
    where id = v_pre.assignment_episode_id and property_id = v_pre.property_id and org_id = p_org_id and ended_at is null for share;
  select * into v_intent from public.dialpad_call_intents
    where id = p_intent_id and org_id = p_org_id and rep_user_id = p_rep_user_id for update;

  if v_intent.status = 'cancelled' then return jsonb_build_object('status', 'cancelled', 'intentId', v_intent.id); end if;
  if v_intent.status = 'matched' then return jsonb_build_object('status', 'matched', 'intentId', v_intent.id); end if;
  if v_intent.expires_at <= now() then
    return jsonb_build_object('status', 'expired', 'intentId', v_intent.id, 'expiresAt', v_intent.expires_at);
  end if;
  if v_intent.dispatch_authorized_at is not null then
    return jsonb_build_object('status', 'already_dispatched', 'intentId', v_intent.id,
      'expiresAt', v_intent.expires_at, 'dispatchAuthorizedAt', v_intent.dispatch_authorized_at);
  end if;

  select * into v_conn from public.dialpad_org_connections where id = v_intent.connection_id and org_id = p_org_id;
  if not found or v_conn.status <> 'active' then
    v_denial := 'connection_inactive';
  elsif not exists (select 1 from public.acquisition_org_settings where org_id = p_org_id and my_leads_enabled) then
    v_denial := 'my_leads_disabled';
  elsif not public.dialpad_cti_member_is_active(p_org_id, p_rep_user_id)
     or not exists (select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_rep_user_id and m.acquisitions_enabled) then
    v_denial := 'rep_not_active';
  elsif v_binding.id is null or v_binding.status <> 'verified' or v_binding.user_id <> p_rep_user_id
     or v_binding.dialpad_user_id <> v_intent.dialpad_user_id then
    v_denial := 'binding_not_verified';
  elsif v_intent.number_grant_id is not null
     and (v_grant.id is null or v_grant.status <> 'active' or v_grant.user_id <> p_rep_user_id
          or v_grant.caller_number_e164 is distinct from v_intent.caller_number_e164) then
    v_denial := 'caller_grant_unavailable';
  elsif v_property.id is null or v_property.deleted_at is not null then
    v_denial := 'property_unavailable';
  elsif coalesce(v_property.is_dnc_locked, false) then
    v_denial := 'property_dnc_locked';
  elsif v_episode.id is null or v_episode.assignee_user_id <> p_rep_user_id or not v_episode.eligible
     or v_property.assigned_user_id is distinct from p_rep_user_id then
    v_denial := 'not_assigned_rep';
  else
    select * into v_contact from public.contacts where id = v_intent.contact_id and org_id = p_org_id;
    if not found then
      v_denial := 'contact_not_on_property';
    elsif v_property.homeowner_contact_id is distinct from v_intent.contact_id and not exists (
         select 1 from public.property_contacts pc
         where pc.org_id = p_org_id and pc.property_id = v_intent.property_id and pc.contact_id = v_intent.contact_id) then
      v_denial := 'contact_not_on_property';
    elsif v_contact.do_not_contact then
      v_denial := 'contact_do_not_contact';
    else
      v_raw := case v_intent.phone_slot when 1 then v_contact.phone_1 when 2 then v_contact.phone_2 else v_contact.phone_3 end;
      if public.dialpad_cti_normalize_us_phone(v_raw) is distinct from v_intent.destination_e164 then
        v_denial := 'phone_unavailable';
      elsif exists (select 1 from public.global_phone_dnc_registry r
                    where r.org_id = p_org_id and r.phone_e164 = v_intent.destination_e164) then
        v_denial := 'phone_dnc';
      end if;
    end if;
  end if;

  if v_denial is not null then
    update public.dialpad_call_intents set status = 'cancelled', cancelled_at = now() where id = v_intent.id;
    return jsonb_build_object('status', 'denied', 'intentId', v_intent.id, 'denial', v_denial);
  end if;

  update public.dialpad_call_intents set dispatch_authorized_at = now() where id = v_intent.id
    returning * into v_intent;

  return jsonb_build_object(
    'status', 'authorized', 'intentId', v_intent.id,
    'expiresAt', v_intent.expires_at, 'dispatchAuthorizedAt', v_intent.dispatch_authorized_at,
    'dial', jsonb_build_object(
      'phoneNumber', v_intent.destination_e164,
      'customData', v_intent.custom_data,
      'identityType', v_intent.caller_identity_type,
      'identityId', v_intent.caller_identity_id,
      'outboundCallerId', case when v_intent.caller_identity_type is null then v_intent.caller_number_e164 end));
end;
$$;

-- ----------------------------------------------------------------------------
-- Webhook-derived call status
-- ----------------------------------------------------------------------------
-- States: prepared (not yet released), awaiting_provider (released, no signed
-- event yet), dialing (signed event bound, no evidence the call was answered),
-- connected (signed connected/date_connected evidence, not ended), ended,
-- cancelled, expired (window elapsed with no signed event bound). `connected`
-- is also returned as a boolean so an ended call says whether it was answered.
create or replace function public.fn_get_dialpad_call_status(
  p_org_id uuid, p_rep_user_id uuid, p_intent_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_intent public.dialpad_call_intents%rowtype;
  v_activity public.call_activities%rowtype;
  v_attempt_id uuid;
  v_state text;
  v_connected boolean;
begin
  if p_org_id is null or p_rep_user_id is null or p_intent_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_intent from public.dialpad_call_intents
    where id = p_intent_id and org_id = p_org_id and rep_user_id = p_rep_user_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  -- Connected only on signed evidence that both parties answered: a 'connected'
  -- event or a date_connected timestamp (Dialpad documents it as present only
  -- after answering) on any matched event. Any-event semantics make this
  -- independent of arrival order, and identical to the A3 projection's rule.
  select coalesce(bool_or(e.event_state = 'connected' or public.dialpad_cti_payload_ms(e.payload, 'date_connected') is not null), false)
    into v_connected
    from public.dialpad_call_events e
    where e.org_id = p_org_id and e.matched_intent_id = v_intent.id and e.disposition = 'matched';

  select * into v_activity from public.call_activities
    where org_id = p_org_id and provider = 'dialpad' and jitter_attempt_id = 'dialpad-cti:' || v_intent.id::text;
  select id into v_attempt_id from public.acquisition_attempts
    where org_id = p_org_id and source = 'dialpad' and provider_attempt_key = 'dialpad-cti:' || v_intent.id::text;

  v_state := case
    when v_intent.status = 'cancelled' then 'cancelled'
    when v_intent.status = 'matched' and v_activity.id is not null and v_activity.ended_at is not null then 'ended'
    when v_intent.status = 'matched' and v_connected then 'connected'
    when v_intent.status = 'matched' then 'dialing'
    when v_intent.expires_at <= now() then 'expired'
    when v_intent.dispatch_authorized_at is not null then 'awaiting_provider'
    else 'prepared'
  end;

  return jsonb_build_object(
    'intentId', v_intent.id, 'state', v_state, 'connected', v_connected, 'propertyId', v_intent.property_id,
    'expiresAt', v_intent.expires_at, 'dispatchAuthorizedAt', v_intent.dispatch_authorized_at,
    'callActivityId', v_activity.id, 'attemptId', v_attempt_id,
    'startedAt', v_activity.started_at, 'endedAt', v_activity.ended_at,
    'durationSeconds', v_activity.duration_seconds, 'talkDurationSeconds', v_activity.talk_duration_seconds);
end;
$$;

revoke all on function public.fn_authorize_dialpad_dispatch(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_get_dialpad_call_status(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.dialpad_cti_guard_intent() from public, anon, authenticated;
grant execute on function public.fn_authorize_dialpad_dispatch(uuid, uuid, uuid) to service_role;
grant execute on function public.fn_get_dialpad_call_status(uuid, uuid, uuid) to service_role;
