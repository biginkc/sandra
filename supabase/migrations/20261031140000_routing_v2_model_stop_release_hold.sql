-- 20261031140000: model_stop_suppression hold-and-suppress (Fable N-1 at 0378182042c6 / Opus N6).
-- On the stop road the atomic recorder (routing_v2_record_live_decision, 20261031132200) writes the
-- safety hold BEFORE the PR-I adapter decides. With model_stop_suppression on, a Jev-decided stop
-- (>= the adapter's threshold, unchanged here) was then suppressed AND left held for a person,
-- contrary to the settled PR-I rule (Jev-decided -> automatic suppression; Haiku-decided -> hold +
-- alert).
-- routing_v2_apply_model_stop_and_release: one transaction that
--   1. takes the phone advisory lock and the contacts' row locks first, in the order every phone
--      action uses (fn_routing_v2_phone_action_apply_all), each wait capped at 2 s,
--   2. runs fn_apply_model_stop_suppression unchanged (flags, canary eligibility, idempotency),
--   3. only when that suppressed the phone (suppressed / already_suppressed / duplicate), takes the
--      property's routing v2 lock and releases
--      the hold THIS inbound's decision wrote (hold_kind 'safety', hold_inbound_message_id = the
--      inbound), audited as ai_escalation_cleared (reason model_stop_suppressed).
-- The hold is left alone when it is about anything else (another inbound, a legacy or person hold)
-- or while the lead has ANOTHER unrecovered SAFETY obligation (the apply gate's test: a safety
-- decision whose effects never landed, or a v2_safety_hold_failed claim, on a text the sweep has
-- not handled): clearing it then would release that obligation too. A release is audited only if
-- the hold really ended.
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
  v_still_held boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  -- Astra N3 (review of 1d7825003): the lock order used everywhere (fn_routing_v2_phone_action_apply_all):
  -- phone advisory -> contacts rows -> (suppression) -> per-property advisory -> properties row.
  -- Every wait is capped; a busy lock = not_eligible (nothing written, the hold stays).
  set local lock_timeout = '2s';
  begin
    if p_phone_e164 is not null then
      perform public.routing_v2_phone_lock(p_org_id, p_phone_e164);
    end if;
    perform 1 from public.contacts c
    where c.org_id = p_org_id
      and (c.id = p_contact_id
           or (p_phone_e164 is not null and (c.phone_1 = p_phone_e164 or c.phone_2 = p_phone_e164 or c.phone_3 = p_phone_e164
               or c.id in (select cp.contact_id from public.contact_phone_numbers cp
                           where cp.org_id = p_org_id and cp.digits10 = public.routing_v2_phone_digits(p_phone_e164)))))
    order by c.id for update;
  exception when lock_not_available then
    return jsonb_build_object('status', 'not_eligible', 'reason', 'lock_timeout', 'hold', 'none');
  end;
  r := public.fn_apply_model_stop_suppression(p_org_id, p_phone_e164, p_inbound_message_id, p_property_id, p_contact_id, p_detail);
  if p_property_id is null or coalesce(r->>'status', '') not in ('suppressed', 'already_suppressed', 'duplicate') then
    return r || jsonb_build_object('hold', 'none');
  end if;
  -- The suppression stands from here; only the release below may give up (it then keeps the hold).
  begin
    set local lock_timeout = '2s';
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || p_property_id::text));
    select * into prop from public.properties where id = p_property_id and org_id = p_org_id for update;
  exception when lock_not_available then
    return r || jsonb_build_object('hold', 'kept_lock_timeout');
  end;
  if not found or not coalesce(prop.needs_human_attention, false) then
    return r || jsonb_build_object('hold', 'none');
  end if;
  if prop.hold_kind is distinct from 'safety' or prop.hold_inbound_message_id is distinct from p_inbound_message_id then
    return r || jsonb_build_object('hold', 'kept_other_hold');
  end if;
  -- Astra N1: only another SAFETY obligation keeps the hold: the apply gate's own test
  -- (20261031132200), i.e. an older text not handled by the sweep with a safety decision whose
  -- effects never landed, or a v2 safety hold that could not be written. An ordinary decision
  -- (a normal reply) never records effects and is not an obligation.
  -- (Astra N2: when the obligations ledger, #956, lands, this becomes
  -- routing_v2_has_unresolved_obligation; reconciled in whichever PR lands second.)
  if exists (
    select 1 from public.messages om
    where om.property_id = p_property_id and om.direction = 'inbound' and om.id <> p_inbound_message_id
      and om.metadata->'processing'->'routingV2Sweep' is null
      and (exists (select 1 from public.routing_v2_live_decisions d
                   where d.inbound_message_id = om.id and d.effects_applied_at is null
                     and d.status in ('decided','failed') and (d.status = 'failed' or d.action is null or d.action->>'road' = 'stop'
           or (d.action->>'road' is distinct from 'bad_number'
               and exists (select 1 from jsonb_array_elements(coalesce(d.action->'steps', '[]'::jsonb)) s where s->>'kind' = 'hold')
               and not exists (select 1 from jsonb_array_elements(coalesce(d.action->'steps', '[]'::jsonb)) s where s->>'kind' = 'wrong_number_close'))))
           or exists (select 1 from public.ai_response_claims oc
                      where oc.inbound_message_id = om.id and oc.response_kind = 'sms_ai_responder_v1'
                        and oc.status = 'error' and oc.error_message = 'v2_safety_hold_failed'))
  ) then
    return r || jsonb_build_object('hold', 'kept_other_obligation');
  end if;
  update public.properties
    set needs_human_attention = false, last_ai_escalation_reason = null, last_ai_escalation_at = null, updated_at = now()
    where id = p_property_id
    returning needs_human_attention into v_still_held;
  -- Astra N2: audit only a release that really happened (a database guard may keep the hold).
  if coalesce(v_still_held, true) then
    return r || jsonb_build_object('hold', 'kept_by_database');
  end if;
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
