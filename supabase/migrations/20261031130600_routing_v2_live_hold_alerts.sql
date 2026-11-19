-- Routing v2 cutover (a): owner alerts for a HELD live decision.
--
-- A v2 decision that holds for a person (possible stop, Haiku unsure / error, needs a person)
-- is refused by routing_v2_apply_live_transition (holds need their own adapter). The hold
-- itself is today's hold (dispatch writes the existing reason). This function queues the
-- stored action's owner-alert intents for that inbound, exactly once, under the property lock:
-- no seller reply, no drip change. It reuses routing_v2_record_alerts_only (20261031130500),
-- so the transition row is `superseded` (never the property's latest).
--
-- Every alert must come from the stored evidence (N3); a plan with a reply or a drip is refused.
-- Flag-off and additive: nothing calls it while routing_v2 is off.
-- Rollback: supabase/rollbacks/20261031130600_routing_v2_live_hold_alerts.sql
begin;
set local lock_timeout = '5s';

create or replace function public.routing_v2_record_live_hold(
  p_inbound_message_id uuid, p_property_id uuid, p_decision jsonb
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
  evidence public.routing_v2_live_decisions;
  existing public.routing_v2_reply_transitions;
  v_item jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || p_property_id::text));
  select * into evidence from public.routing_v2_live_decisions
    where inbound_message_id=p_inbound_message_id and property_id=p_property_id;
  if not found or evidence.status<>'decided' or evidence.action is null then
    return jsonb_build_object('outcome','evidence_missing');
  end if;
  if p_decision->>'road' is distinct from evidence.road then
    return jsonb_build_object('outcome','evidence_mismatch');
  end if;
  if nullif(p_decision->>'sequence_key','') is not null
     or coalesce((p_decision->>'skip_first_step')::boolean,false)
     or coalesce((p_decision->>'stop_drip_when_time_only_on')::boolean,false) then
    return jsonb_build_object('outcome','evidence_mismatch');
  end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_decision->'outbox','[]'::jsonb)) loop
    if (v_item->>'kind') is distinct from 'alert' or not exists(
      select 1 from jsonb_array_elements(evidence.action->'steps') s
      where s->>'kind'='alert' and s->>'reason' = v_item->'payload'->>'reason'
        and coalesce((s->>'whenTimeOnlyOff')::boolean,false)
            = coalesce((v_item->'payload'->>'when_time_only_off')::boolean,false)) then
      return jsonb_build_object('outcome','evidence_mismatch');
    end if;
  end loop;
  select * into existing from public.routing_v2_reply_transitions where inbound_message_id=p_inbound_message_id;
  if found then return to_jsonb(existing)||jsonb_build_object('replayed',true); end if;
  return public.routing_v2_record_alerts_only(p_inbound_message_id,p_property_id,p_decision,'hold')
    || jsonb_build_object('outcome','held');
end;
$$;
revoke all on function public.routing_v2_record_live_hold(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.routing_v2_record_live_hold(uuid,uuid,jsonb) to service_role;
commit;
