-- 20261031140000: model_stop_suppression hold-and-suppress (Fable N-1 at 0378182042c6 / Opus N6).
-- On the stop road the atomic recorder (routing_v2_record_live_decision, 20261031132200) writes the
-- safety hold BEFORE the PR-I adapter decides. With model_stop_suppression on, a Jev-decided stop
-- (>= the adapter's threshold, unchanged here) was then suppressed AND left held for a person,
-- contrary to the settled PR-I rule (Jev-decided -> automatic suppression; Haiku-decided -> hold +
-- alert).
-- routing_v2_apply_model_stop_and_release: one transaction that
--   1. takes the property's routing v2 lock (same order as the recorder: advisory lock, then rows),
--   2. runs fn_apply_model_stop_suppression unchanged (flags, canary eligibility, idempotency),
--   3. only when that suppressed the phone (suppressed / already_suppressed / duplicate), releases
--      the hold THIS inbound's decision wrote (hold_kind 'safety', hold_inbound_message_id = the
--      inbound), audited as ai_escalation_cleared (reason model_stop_suppressed).
-- The hold is left alone when it is about anything else (another inbound, a legacy or person hold)
-- or while the lead has ANOTHER unrecovered safety obligation (a decision whose effects never
-- landed, or a v2_safety_hold_failed claim): clearing it then would release that obligation too.
-- A crash before commit leaves the hold (fail safe); suppression and release commit together.
-- Haiku-decided stops, flag off and every failure never reach the release (the adapter returns
-- hold_alert / human_review before calling this).
-- Rollback: supabase/rollbacks/20261031140000_routing_v2_model_stop_release_hold.sql
begin;
set local lock_timeout = '5s';

create or replace function public.routing_v2_apply_model_stop_and_release(
  p_org_id uuid,
  p_phone_e164 text,
  p_inbound_message_id uuid,
  p_property_id uuid,
  p_contact_id uuid,
  p_detail jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r jsonb;
  prop public.properties;
  v_hold text := 'none';
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_property_id is not null then
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || p_property_id::text));
  end if;
  r := public.fn_apply_model_stop_suppression(p_org_id, p_phone_e164, p_inbound_message_id, p_property_id, p_contact_id, p_detail);
  if p_property_id is null or coalesce(r->>'status', '') not in ('suppressed', 'already_suppressed', 'duplicate') then
    return r || jsonb_build_object('hold', v_hold);
  end if;
  select * into prop from public.properties where id = p_property_id and org_id = p_org_id for update;
  if not found or not coalesce(prop.needs_human_attention, false) then
    return r || jsonb_build_object('hold', v_hold);
  end if;
  if prop.hold_kind is distinct from 'safety' or prop.hold_inbound_message_id is distinct from p_inbound_message_id then
    return r || jsonb_build_object('hold', 'kept_other_hold');
  end if;
  if exists (select 1 from public.routing_v2_live_decisions d
             where d.property_id = p_property_id and d.inbound_message_id <> p_inbound_message_id
               and d.effects_applied_at is null and d.status in ('decided', 'failed'))
     or exists (select 1 from public.ai_response_claims c
                where c.property_id = p_property_id and c.inbound_message_id <> p_inbound_message_id
                  and c.response_kind = 'sms_ai_responder_v1'
                  and c.status = 'error' and c.error_message = 'v2_safety_hold_failed') then
    return r || jsonb_build_object('hold', 'kept_other_obligation');
  end if;
  update public.properties
    set needs_human_attention = false, last_ai_escalation_reason = null, last_ai_escalation_at = null, updated_at = now()
    where id = p_property_id;
  insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
  values (p_org_id, p_property_id, 'system', 'ai_escalation_cleared', jsonb_build_object(
    'reason', 'model_stop_suppressed', 'cleared_hold_reason', prop.last_ai_escalation_reason,
    'hold_inbound_message_id', p_inbound_message_id, 'suppression_status', r->>'status',
    'suppression_id', r->>'suppressionId'));
  return r || jsonb_build_object('hold', 'released');
end;
$$;
revoke all on function public.routing_v2_apply_model_stop_and_release(uuid,text,uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.routing_v2_apply_model_stop_and_release(uuid,text,uuid,uuid,uuid,jsonb) to service_role;

commit;
