-- 20261031131700: review of 3288da8ef6b3.
-- B-1  A hold about the seller's words (possible stop, legal / keyword, needs a person) stacked on
--      a mechanics hold (our own reply could not go out) must never keep the mechanics label: the
--      next text would clear it. Any re-assertion of a hold on an already-held mechanics lead
--      upgrades it to safety (never downgrades):
--      * trigger (covers every SQL / UI writer that sets the flag or the reason on a held lead);
--      * routing_v2_record_live_hold upgrades through routing_v2_write_hold;
--      * the app's markPropertyNeedsAttention already-held branch calls routing_v2_write_hold.
-- N-6  routing_v2_mark_person_takeover takes ONE property (one routing lock per transaction), so a
--      multi-property takeover can no longer deadlock with the outbox reconcile.
begin;

create or replace function public.routing_v2_hold_reassert_upgrade()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.needs_human_attention and new.needs_human_attention and new.hold_kind is not distinct from 'mechanics' then
    -- A held lead never goes (back) to mechanics: a mechanics hold re-asserted by any writer
    -- becomes safety; a safety or legacy (null) hold keeps its kind.
    if old.hold_kind = 'mechanics' then
      new.hold_kind := 'safety';
    else
      new.hold_kind := old.hold_kind;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_routing_v2_hold_reassert_upgrade on public.properties;
create trigger trg_routing_v2_hold_reassert_upgrade
  before update of needs_human_attention, last_ai_escalation_reason, hold_kind on public.properties
  for each row execute function public.routing_v2_hold_reassert_upgrade();

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
  -- 20261031131700 (review B-1): a hold about the seller's words never stays labelled as our own
  -- send failure: a mechanics label on an already-held lead becomes safety (never downgraded),
  -- so a newer text can no longer clear it.
  -- The reason is this decision's own hold (as liveHoldReason maps it in the app).
  perform public.routing_v2_write_hold(p_property_id, p_inbound_message_id,
      case when exists (select 1 from jsonb_array_elements(evidence.action->'steps') s
                        where s->>'kind' = 'hold' and s->>'reason' = 'asked_stop')
           then 'nine_asked_stop' else 'nine_needs_person' end, 'safety')
    from public.properties p where p.id = p_property_id and p.needs_human_attention and p.hold_kind = 'mechanics';
  return public.routing_v2_record_alerts_only(p_inbound_message_id,p_property_id,p_decision,'hold')
    || jsonb_build_object('outcome','held');
end;
$$;
revoke all on function public.routing_v2_record_live_hold(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.routing_v2_record_live_hold(uuid,uuid,jsonb) to service_role;

drop function if exists public.routing_v2_mark_person_takeover(uuid[]);
create or replace function public.routing_v2_mark_person_takeover(p_property_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || p_property_id::text));
  update public.properties set last_person_takeover_at = clock_timestamp() where id = p_property_id;
  return found;
end;
$$;
revoke all on function public.routing_v2_mark_person_takeover(uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_mark_person_takeover(uuid) to service_role;

commit;
