-- 20261031131800: review of 251a3321672a.
-- B-1' The wrong-number-all superseded hold wrote nine_needs_person only where the lead was not
--      held, so on a lead held only for our own unsent reply (mechanics) it wrote nothing and the
--      next text cleared that hold. It now goes through routing_v2_write_hold as safety.
-- N-5  routing_v2_hold_reassert_upgrade() (430000) gets the same revoke as the 420000 trigger
--      functions.
begin;
set local lock_timeout = '5s';

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
  -- A DNC-locked property (e.g. a manual contact do_not_contact) is never written (the DNC
  -- lock guard would reject it and the settler would retry forever): the reply is still
  -- skipped and audited, just without the hold.
  -- 20261031131800 (review B-1' of 251a3321672a): through the one hold writer as safety, so a
  -- lead already held only for our own unsent reply (mechanics) is upgraded, not left clearable.
  v_held := false;
  if exists (select 1 from public.properties where id = v.source_property_id and org_id = v.org_id
             and is_dnc_locked = false) then
    v_held := public.routing_v2_write_hold(v.source_property_id, v.source_inbound_message_id,
      'nine_needs_person', 'safety') in ('held', 'upgraded');
  end if;
  insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
  values (v.org_id, v.source_property_id, 'system', 'routing_v2_phone_action_' || p_event,
    jsonb_build_object('phone_action_id', v.id, 'newer_inbound_message_id', p_newer, 'hold_set', v_held,
      'hold_reason', 'nine_needs_person'));
  return v_held;
end;
$$;
revoke all on function public.routing_v2_phone_action_hold_superseded(uuid, uuid, text) from public, anon, authenticated, service_role;

revoke all on function public.routing_v2_hold_reassert_upgrade() from public, anon, authenticated;

commit;
