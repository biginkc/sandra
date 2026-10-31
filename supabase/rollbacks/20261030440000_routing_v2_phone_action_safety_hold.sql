-- Rollback of 20261030440000: restores the 250000 routing_v2_phone_action_hold_superseded.
begin;
create or replace function public.routing_v2_phone_action_hold_superseded(p_action_id uuid, p_newer uuid, p_event text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_phone_actions%rowtype;
  v_held boolean;
begin
  if p_event not in ('superseded_after_commit', 'superseded_before_send') then
    raise exception 'unsupported event: %', p_event using errcode = '22023';
  end if;
  select * into v from public.routing_v2_phone_actions where id = p_action_id;
  update public.routing_v2_phone_actions
  set reply_state = 'skipped', reply_reason = p_event, reply_updated_at = now()
  where id = v.id;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.source_property_id::text));
  update public.properties
  set needs_human_attention = true, last_ai_escalation_reason = 'nine_needs_person',
      last_ai_escalation_at = now(), updated_at = now()
  -- A DNC-locked property (e.g. a manual contact do_not_contact) is never written (the DNC
  -- lock guard would reject it and the settler would retry forever): the reply is still
  -- skipped and audited, just without the hold.
  where id = v.source_property_id and org_id = v.org_id and needs_human_attention = false and is_dnc_locked = false;
  v_held := found;
  insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
  values (v.org_id, v.source_property_id, 'system', 'routing_v2_phone_action_' || p_event,
    jsonb_build_object('phone_action_id', v.id, 'newer_inbound_message_id', p_newer, 'hold_set', v_held,
      'hold_reason', 'nine_needs_person'));
  return v_held;
end;
$$;
revoke all on function public.routing_v2_phone_action_hold_superseded(uuid, uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.routing_v2_hold_reassert_upgrade() to public, anon, authenticated;
commit;
