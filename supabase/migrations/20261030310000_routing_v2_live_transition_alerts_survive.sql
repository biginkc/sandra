-- Routing v2 cutover: the live-transition wrapper (20261030290000) re-created from its latest
-- body with three changes. Flag-off and additive: nothing calls it while routing_v2 is off.
--
-- B1. Owner alerts survive a newer seller reply. A stale decision (the property revision moved,
--     or a newer inbound exists) no longer returns early with nothing written. It records the
--     transition as `superseded` (so it never counts as the property's latest transition) and
--     queues ONLY the evidence's owner-alert intents. No seller reply, no drip change.
--     ("Call me Tuesday 3pm" then "Thanks" keeps the call-me alert.)
-- B2. A missing v2 drip is never silent. If the stored road names a drip the org has no v2
--     sequence for (or skip-first needs a step 1 the snapshot lacks), the wrapper refuses
--     before route_reply_transition retires the current drip. It records an alerts-only
--     `superseded` transition and returns `no_sequence`, so the caller holds for a person
--     (existing needs_person hold).
-- N3. The effects are bound to the stored evidence, not the caller: every outbox item must
--     match a reply/alert step of the stored action, sequence_key must be the stored drip's key,
--     skip_first_step must match the stored step and stop_drip must be in the stored action.
--     A caller may drop effects (flag-gated), never add or swap one.
--
-- Rollback: supabase/rollbacks/20261030310000_routing_v2_live_transition_alerts_survive.sql
-- (restores the 20261030290000 body byte for byte).
begin;
set local lock_timeout = '5s';

create or replace function public.routing_v2_live_drip_key(p_drip text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  -- Mirrors V2_SEQUENCE_KEYS in src/lib/sms-classification/routing-v2/transition-plan.ts.
  select case p_drip
    when 'Book appointment' then 'book_appointment'
    when 'Said they''d call' then 'said_theyd_call'
    when 'Price too high' then 'price_too_high'
    when 'Vacant land' then 'vacant_land'
    when 'Listed, not selling' then 'listed_not_selling'
    when 'Maybe later' then 'maybe_later'
    when 'Not interested' then 'not_interested'
    when 'Asked who is texting' then 'asked_who'
    when 'Confirmed owner' then 'confirmed_owner'
  end;
$$;
revoke all on function public.routing_v2_live_drip_key(text) from public, anon, authenticated;
grant execute on function public.routing_v2_live_drip_key(text) to service_role;

-- Alerts-only record for a decision that must not change drips or reply to the seller.
-- Caller holds the property advisory lock. Outcome `superseded` keeps it out of
-- "latest transition" checks; the reason is kept in the stored decision.
create or replace function public.routing_v2_record_alerts_only(
  p_inbound_message_id uuid, p_property_id uuid, p_decision jsonb, p_reason text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
  v_org uuid;
  v_inbound_at timestamptz;
  v_seq bigint;
  v_item jsonb;
  v_alerts integer := 0;
  v_row public.routing_v2_reply_transitions;
begin
  select m.org_id, m.created_at into v_org, v_inbound_at from public.messages m
    where m.id=p_inbound_message_id and m.property_id=p_property_id and m.direction='inbound';
  if v_org is null then return jsonb_build_object('outcome','bad_inbound'); end if;
  select coalesce(max(transition_seq),0)+1 into v_seq
    from public.routing_v2_reply_transitions where property_id=p_property_id;
  for v_item in select * from jsonb_array_elements(coalesce(p_decision->'outbox','[]'::jsonb)) loop
    if (v_item->>'kind')='alert'
       and public.routing_v2_slice_enabled(p_property_id, coalesce(nullif(v_item->>'slice',''),'replies')) then
      insert into public.routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice, payload)
      values (v_org, p_property_id, p_inbound_message_id, v_seq, 'alert', 'v2',
              coalesce(nullif(v_item->>'slice',''),'replies'), coalesce(v_item->'payload','{}'::jsonb));
      v_alerts := v_alerts + 1;
    end if;
  end loop;
  insert into public.routing_v2_reply_transitions
    (org_id, property_id, inbound_message_id, inbound_at, transition_seq, outcome, decision)
  values (v_org, p_property_id, p_inbound_message_id, v_inbound_at, v_seq, 'superseded',
          p_decision || jsonb_build_object('alerts_only_reason', p_reason))
  returning * into v_row;
  return to_jsonb(v_row) || jsonb_build_object('replayed', false, 'alerts_only_reason', p_reason, 'alerts_queued', v_alerts);
end;
$$;
revoke all on function public.routing_v2_record_alerts_only(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.routing_v2_record_alerts_only(uuid,uuid,jsonb,text) to service_role;

create or replace function public.routing_v2_apply_live_transition(
  p_inbound_message_id uuid, p_property_id uuid, p_decision jsonb
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
  evidence public.routing_v2_live_decisions;
  msg public.messages;
  prop public.properties;
  existing public.routing_v2_reply_transitions;
  v_item jsonb;
  v_key text := nullif(p_decision->>'sequence_key','');
  v_skip boolean := coalesce((p_decision->>'skip_first_step')::boolean,false);
  v_drip jsonb;
  v_sequence uuid;
  v_drips boolean;
  v_stale text;
begin
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || p_property_id::text));
  select * into evidence from public.routing_v2_live_decisions
    where inbound_message_id=p_inbound_message_id and property_id=p_property_id;
  if not found or evidence.status<>'decided' or evidence.action is null then
    return jsonb_build_object('outcome','evidence_missing');
  end if;
  select * into msg from public.messages where id=p_inbound_message_id
    and property_id=p_property_id and org_id=evidence.org_id and direction='inbound';
  if not found then return jsonb_build_object('outcome','bad_inbound'); end if;
  if p_decision->>'road' is distinct from evidence.road
    or nullif(p_decision->>'contact_id','')::uuid is distinct from msg.contact_id then
    return jsonb_build_object('outcome','evidence_mismatch');
  end if;
  -- Holds and phone-wide changes need their dedicated reviewed adapters. A caller cannot
  -- accidentally turn them into a normal auto-send transition via this RPC.
  if exists(select 1 from jsonb_array_elements(evidence.action->'steps') step
    where step->>'kind' in ('hold','wrong_number_close')) then
    return jsonb_build_object('outcome','specialized_action_required');
  end if;
  -- N3. Every effect must come from the stored action.
  for v_item in select * from jsonb_array_elements(coalesce(p_decision->'outbox','[]'::jsonb)) loop
    if not (
      ((v_item->>'kind')='reply' and exists(select 1 from jsonb_array_elements(evidence.action->'steps') s
         where s->>'kind'='reply' and s->>'key' = v_item->'payload'->>'key'))
      or ((v_item->>'kind')='alert' and exists(select 1 from jsonb_array_elements(evidence.action->'steps') s
         where s->>'kind'='alert' and s->>'reason' = v_item->'payload'->>'reason'
           and coalesce((s->>'whenTimeOnlyOff')::boolean,false)
               = coalesce((v_item->'payload'->>'when_time_only_off')::boolean,false)))
    ) then
      return jsonb_build_object('outcome','evidence_mismatch');
    end if;
  end loop;
  select s into v_drip from jsonb_array_elements(evidence.action->'steps') s where s->>'kind'='drip' limit 1;
  if v_key is not null and (v_drip is null or public.routing_v2_live_drip_key(v_drip->>'drip') is distinct from v_key
       or v_skip is distinct from coalesce((v_drip->>'skipFirstStep')::boolean,false)) then
    return jsonb_build_object('outcome','evidence_mismatch');
  end if;
  if v_key is null and v_skip then return jsonb_build_object('outcome','evidence_mismatch'); end if;
  if coalesce((p_decision->>'stop_drip_when_time_only_on')::boolean,false)
     and not exists(select 1 from jsonb_array_elements(evidence.action->'steps') s where s->>'kind'='stop_drip') then
    return jsonb_build_object('outcome','evidence_mismatch');
  end if;

  select * into existing from public.routing_v2_reply_transitions where inbound_message_id=p_inbound_message_id;
  if found then return to_jsonb(existing)||jsonb_build_object('replayed',true); end if;
  select * into prop from public.properties where id=p_property_id and org_id=evidence.org_id for update;
  if not found then return jsonb_build_object('outcome','context_changed'); end if;

  -- B1. Stale decision: owner alerts only. A newer inbound is named first (it also bumps the
  -- revision); any other revision move is context_changed.
  if exists(select 1 from public.messages m where m.property_id=p_property_id and m.direction='inbound'
    and (m.created_at>msg.created_at or (m.created_at=msg.created_at and m.id>msg.id))) then
    v_stale := 'superseded';
  elsif exists(select 1 from public.routing_v2_reply_transitions t
    where t.property_id=p_property_id and t.outcome<>'superseded'
      and (t.inbound_at>msg.created_at or (t.inbound_at=msg.created_at and t.inbound_message_id>msg.id))) then
    v_stale := 'superseded';
  elsif prop.decision_context_revision is distinct from evidence.expected_revision then
    v_stale := 'context_changed';
  end if;
  if v_stale is not null then
    return public.routing_v2_record_alerts_only(p_inbound_message_id,p_property_id,p_decision,v_stale)
      || jsonb_build_object('outcome', v_stale);
  end if;

  -- B2. A drip that cannot be started must never end the current drip silently.
  v_drips := public.routing_v2_slice_enabled(p_property_id,'drips');
  if v_key is not null and v_drips then
    v_sequence := public.routing_v2_sequence_for(evidence.org_id, v_key);
    if v_sequence is null or (v_skip and not exists(
        select 1 from public.sequence_steps where sequence_id=v_sequence and step_index=1)) then
      return public.routing_v2_record_alerts_only(p_inbound_message_id,p_property_id,p_decision,'no_sequence')
        || jsonb_build_object('outcome','no_sequence');
    end if;
  end if;
  return public.route_reply_transition(p_inbound_message_id,p_property_id,p_decision);
end;
$$;
revoke all on function public.routing_v2_apply_live_transition(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.routing_v2_apply_live_transition(uuid,uuid,jsonb) to service_role;
commit;
