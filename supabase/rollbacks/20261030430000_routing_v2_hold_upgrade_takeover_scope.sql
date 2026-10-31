-- Rollback of 20261030430000: restores the 320000 routing_v2_record_live_hold and the 420000
-- multi-property routing_v2_mark_person_takeover.
begin;
drop trigger if exists trg_routing_v2_hold_reassert_upgrade on public.properties;
drop function if exists public.routing_v2_hold_reassert_upgrade();
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

drop function if exists public.routing_v2_mark_person_takeover(uuid);
create or replace function public.routing_v2_mark_person_takeover(p_property_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_n integer := 0;
begin
  for v_id in select distinct x from unnest(coalesce(p_property_ids, '{}')) x order by 1 loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || v_id::text));
    update public.properties set last_person_takeover_at = clock_timestamp() where id = v_id;
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.routing_v2_mark_person_takeover(uuid[]) from public, anon, authenticated;
grant execute on function public.routing_v2_mark_person_takeover(uuid[]) to service_role;
commit;
