-- 20261031140300: the model-stop release wrapper asks the one obligation store (Astra N2 / Opus N1 on
-- #954, reconciled by #956, whichever landed second). 20261031140000's
-- routing_v2_apply_model_stop_and_release decided "another safety obligation" from the old signals
-- (decision rows whose effects never landed, v2_safety_hold_failed claims). Since 20261031140100 /
-- 132400 the obligation store (rows + fallback marker) is the one representation, so the wrapper
-- now calls routing_v2_has_unresolved_obligation. Everything else is 140000's body unchanged (lock
-- order, lock timeouts, suppression call, hold-about-this-inbound rule, audit only a real release).
-- Rollback: supabase/rollbacks/20261031140300_routing_v2_model_stop_release_obligations.sql
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
  v_digits text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  -- Astra N3 (review of 1d7825003): the lock order used everywhere (fn_routing_v2_phone_action_apply_all):
  -- phone advisory -> contacts rows -> (suppression) -> per-property advisory -> properties row.
  -- Every wait is capped; a busy lock = not_eligible (nothing written, the hold stays).
  set local lock_timeout = '2s';
  begin
    -- The same key as routing_v2_phone_lock(org, phone) (inlined: no dependency on that helper).
    v_digits := right(regexp_replace(coalesce(p_phone_e164, ''), '\D', '', 'g'), 10);
    if p_phone_e164 is not null then
      perform pg_advisory_xact_lock(hashtext('routing_v2_phone:' || p_org_id::text || ':' || v_digits));
    end if;
    perform 1 from public.contacts c
    where c.org_id = p_org_id
      and (c.id = p_contact_id
           or (p_phone_e164 is not null and (c.phone_1 = p_phone_e164 or c.phone_2 = p_phone_e164 or c.phone_3 = p_phone_e164
               or c.id in (select cp.contact_id from public.contact_phone_numbers cp
                           where cp.org_id = p_org_id and cp.digits10 = v_digits))))
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
  -- 20261031140300 (Astra N2 / Opus N1 on #954, reconciled with #956): one question, one store.
  -- Any unresolved safety obligation of the lead (20261031140100 rows or the 20261031140200
  -- fallback marker) keeps the hold.
  if public.routing_v2_has_unresolved_obligation(p_property_id) then
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
