-- 20261031131900: Astra review of 921b71c2a133 (P1). The final provider-boundary recheck of an
-- authorized v2 outbox intent also refuses an automatic reply to a lead held for a person
-- (needs_human_attention), so a hold committed between the app's last read and the fence wins.
-- Re-created from the 300000 body (the latest); rollback restores it exactly.
begin;
set local lock_timeout = '5s';
create or replace function public.routing_v2_check_authorized_outbox_send(p_outbox_id uuid, p_property_id uuid, p_inbound_message_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_outbox;
  v_latest bigint;
  v_inbound_at timestamptz;
  v_contact uuid;
  v_takeover timestamptz;
  v_locked boolean;
  v_held boolean;
  v_reason text;
begin
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if not found then return 'missing'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.property_id::text));
  select * into v from public.routing_v2_outbox where id = p_outbox_id for update;
  if v.status <> 'claimed' then return 'not_claimed'; end if;
  if v.authorized_at is null then return 'not_authorized'; end if;
  if v.property_id is distinct from p_property_id or v.inbound_message_id is distinct from p_inbound_message_id then return 'identity_mismatch'; end if;

  select max(transition_seq) into v_latest from public.routing_v2_reply_transitions
  where property_id = v.property_id and outcome <> 'superseded';
  select inbound_at into v_inbound_at from public.routing_v2_reply_transitions
  where inbound_message_id = v.inbound_message_id;
  select contact_id into v_contact from public.messages where id = v.inbound_message_id;
  select last_person_takeover_at, coalesce(is_dnc_locked, true), coalesce(needs_human_attention, false)
    into v_takeover, v_locked, v_held
  from public.properties where id = v.property_id;

  if v.kind = 'alert' and v.payload->'when_time_only_off' = 'true'::jsonb
     and public.routing_v2_slice_enabled(v.property_id,'drips')
     and public.routing_v2_slice_enabled(v.property_id,'alert_on_time_only') then
    v_reason := 'time_only_alert_disabled';
  elsif v.kind = 'reply' and v_latest is distinct from v.transition_seq then
    v_reason := 'superseded';
  elsif v.kind = 'reply' and exists(select 1 from public.messages newer join public.messages source on source.id=v.inbound_message_id where newer.property_id=v.property_id and newer.direction='inbound' and (newer.created_at>source.created_at or (newer.created_at=source.created_at and newer.id>source.id))) then
    v_reason := 'superseded';
  elsif v.kind = 'reply' and v_takeover is not null and (v_inbound_at is null or v_takeover >= v_inbound_at) then
    v_reason := 'human_takeover';
  elsif v.kind = 'reply' and (coalesce(v_locked, true) or public.routing_v2_contact_suppressed(v.property_id, v_contact)) then
    v_reason := 'suppressed';
  -- 20261031131900 (Astra review of 921b71c2a133, P1): a lead held for a person (any hold, committed
  -- after the app's last read) gets no automatic reply; read here under the routing lock, right
  -- before the provider. Owner alerts are not refused by a hold.
  elsif v.kind = 'reply' and v_held then
    v_reason := 'held_for_person';
  elsif v.engine is distinct from 'v2' or not public.routing_v2_slice_enabled(v.property_id, v.slice) then
    v_reason := 'flag_off';
  end if;

  if v_reason is not null then
    update public.routing_v2_outbox set status = 'cancelled', cancel_reason = v_reason where id = v.id;
    return v_reason;
  end if;
  return 'ok';
end;
$$;

revoke all on function public.routing_v2_check_authorized_outbox_send(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.routing_v2_check_authorized_outbox_send(uuid,uuid,uuid) to service_role;
commit;
