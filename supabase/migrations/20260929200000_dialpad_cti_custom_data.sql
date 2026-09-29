-- Dialpad CTI: accept the signed `custom_data` shape Dialpad actually sends.
--
-- Depends on A1 (20260929034021) and A3 (20260929120000).
--
-- Dialpad returns the value passed to the CTI `initiate_call` in signed call
-- events as {"open_cti": "<custom_data>"}, not as the bare string. A1 matching
-- and A3 transfer-leg resolution both read `payload ->> 'custom_data'`, which is
-- the JSON text of that object, so a real call quarantined as
-- `unknown_custom_data` and earned no attribution.
--
-- One shared normalizer (dialpad_cti_custom_data) now backs both readers. It
-- accepts exactly two shapes and nothing else:
--   * a nonempty JSON string, unchanged from before; or
--   * a JSON object with exactly one key, `open_cti`, whose value is a nonempty
--     string.
-- Extra keys, nesting, arrays, numbers, booleans, nulls inside the wrapper and
-- empty values are malformed: the event still carries custom_data, matches no
-- intent, and is quarantined as `unknown_custom_data`. It never falls through to
-- the provider-call-id lookup or the transfer-leg link, and there is no alias or
-- phone-number fallback. A missing, JSON-null or empty-string custom_data is
-- "absent", exactly as before.
--
-- Only the extraction changes in the two functions below. Target user, external
-- number, intent window, cancellation, single-match and chain-lock checks are
-- byte-for-byte the A1/A3 logic.

begin;

create or replace function public.dialpad_cti_custom_data(p_value jsonb, out present boolean, out value text)
language sql
immutable
set search_path = ''
as $$
  select
    p_value is not null and p_value <> 'null'::jsonb and p_value <> '""'::jsonb,
    case jsonb_typeof(p_value)
      when 'string' then nullif(p_value #>> '{}', '')
      when 'object' then
        case when (select count(*) from jsonb_object_keys(p_value)) = 1
              and jsonb_typeof(p_value -> 'open_cti') = 'string'
          then nullif(p_value ->> 'open_cti', '')
        end
    end;
$$;

create or replace function public.fn_match_dialpad_call_event(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_event public.dialpad_call_events%rowtype;
  v_intent public.dialpad_call_intents%rowtype;
  v_present boolean;
  v_custom text;
  v_reason text;
  v_found boolean := false;
  c_skew_ms constant bigint := 5000;
begin
  select * into v_event from public.dialpad_call_events where id = p_event_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_event.disposition in ('matched', 'conflict') then
    return jsonb_build_object('eventId', v_event.id, 'disposition', v_event.disposition,
      'intentId', v_event.matched_intent_id, 'reason', v_event.disposition_reason, 'replayed', true);
  end if;

  select n.present, n.value into v_present, v_custom
    from public.dialpad_cti_custom_data(v_event.payload -> 'custom_data') n;
  if v_present then
    select * into v_intent from public.dialpad_call_intents
      where org_id = v_event.org_id and custom_data = v_custom for update;
    v_found := found;
    if not v_found then v_reason := 'unknown_custom_data'; end if;
  else
    select * into v_intent from public.dialpad_call_intents
      where org_id = v_event.org_id and matched_provider_call_id = v_event.provider_call_id for update;
    v_found := found;
    if not v_found then v_reason := 'no_custom_data'; end if;
  end if;

  if v_found then
    if v_intent.status = 'cancelled' then
      v_reason := 'intent_cancelled';
    elsif v_intent.matched_provider_call_id is not null and v_intent.matched_provider_call_id <> v_event.provider_call_id then
      v_reason := 'intent_already_matched';
    elsif lower(coalesce(v_event.payload -> 'target' ->> 'type', '')) <> 'user'
       or (v_event.payload -> 'target' ->> 'id') is distinct from v_intent.dialpad_user_id then
      v_reason := 'target_mismatch';
    elsif (v_event.payload ->> 'external_number') is distinct from v_intent.destination_e164 then
      v_reason := 'number_mismatch';
    elsif v_intent.matched_provider_call_id is null and (
        v_event.event_timestamp_ms < floor(extract(epoch from v_intent.prepared_at) * 1000)::bigint - c_skew_ms
        or v_event.event_timestamp_ms > floor(extract(epoch from v_intent.expires_at) * 1000)::bigint) then
      v_reason := 'outside_intent_window';
    end if;
  end if;

  if v_reason is not null then
    update public.dialpad_call_events
      set disposition = 'quarantined', disposition_reason = v_reason, disposed_at = now()
      where id = v_event.id;
    return jsonb_build_object('eventId', v_event.id, 'disposition', 'quarantined', 'intentId', null,
      'reason', v_reason, 'replayed', false);
  end if;

  if v_intent.matched_provider_call_id is null then
    update public.dialpad_call_intents
      set status = 'matched', matched_provider_call_id = v_event.provider_call_id,
          matched_event_id = v_event.id, matched_at = now()
      where id = v_intent.id;
  end if;
  update public.dialpad_call_events
    set disposition = 'matched', disposition_reason = null, matched_intent_id = v_intent.id, disposed_at = now()
    where id = v_event.id;
  return jsonb_build_object('eventId', v_event.id, 'disposition', 'matched', 'intentId', v_intent.id,
    'reason', null, 'replayed', false);
end;
$$;

create or replace function public.dialpad_cti_resolve_event(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res jsonb;
  v_event public.dialpad_call_events%rowtype;
  v_intent public.dialpad_call_intents%rowtype;
  v_master text;
  v_present boolean;
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

  select n.present, n.value into v_present, v_custom
    from public.dialpad_cti_custom_data(v_event.payload -> 'custom_data') n;
  if v_present and v_custom is distinct from v_intent.custom_data then
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

revoke all on function public.dialpad_cti_custom_data(jsonb) from public, anon, authenticated;
revoke all on function public.fn_match_dialpad_call_event(uuid) from public, anon, authenticated;
revoke all on function public.dialpad_cti_resolve_event(uuid) from public, anon, authenticated;
grant execute on function public.fn_match_dialpad_call_event(uuid) to service_role;

commit;
