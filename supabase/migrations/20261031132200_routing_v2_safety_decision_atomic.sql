-- 20261031132200: Astra third review of b6a00a0a2f17 (fix the class, not the instance).
-- A. routing_v2_record_live_decision: a safety decision and its effects (safety hold, v2 drips
--    paused, pending v2 replies cancelled) commit in one transaction or not at all; the decision
--    row records effects_applied_at.
-- B. The apply gate blocks a newer text while ANY older safety obligation of the lead is
--    unrecovered, whatever its claim state and age; the only exits are the sweep's mark or recorded
--    effects (a hold a person cleared records them). The sweep never ages such a text out.
-- C. Claim leases on the DB clock (trigger), and routing_v2_db_now() for app-side comparisons.
-- D. routing_v2_sweep_candidates takes an optional property (the per-property delivery runs it).
-- Numbered after main's 20261031120000. Rollback restores the 470000 bodies exactly.
begin;
set local lock_timeout = '5s';

alter table public.routing_v2_live_decisions add column if not exists effects_applied_at timestamptz;
-- Existing decisions whose run completed normally had their effects applied by that run.
update public.routing_v2_live_decisions d set effects_applied_at = d.created_at
  where d.effects_applied_at is null and not exists (
    select 1 from public.ai_response_claims c
    where c.inbound_message_id = d.inbound_message_id and c.response_kind = 'sms_ai_responder_v1'
      and (c.status = 'processing' or (c.status = 'error' and c.error_message = 'flag_failed')));

-- A. The atomic recorder: the decision row and (for a safety decision) its hold, the pause of the
--    lead's v2 drips and the cancel of its pending v2 replies commit together, or nothing commits.
create or replace function public.routing_v2_record_live_decision(p_row jsonb, p_hold_reason text default null)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r public.routing_v2_live_decisions;
  v_id uuid;
  v_hold text;
begin
  r := jsonb_populate_record(null::public.routing_v2_live_decisions, p_row);
  if p_hold_reason is not null then
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || r.property_id::text));
  end if;
  insert into public.routing_v2_live_decisions (org_id, property_id, conversation_id, inbound_message_id, status, road, jev_road,
    provenance, haiku_eligibility, haiku, opportunity_alert, probabilities, property_type, action, expected_revision,
    price_outcome, failure_reason, model, latency_ms, effects_applied_at)
  values (r.org_id, r.property_id, r.conversation_id, r.inbound_message_id, r.status, r.road, r.jev_road,
    r.provenance, r.haiku_eligibility, r.haiku, r.opportunity_alert, r.probabilities, r.property_type, r.action, r.expected_revision,
    r.price_outcome, r.failure_reason, r.model, r.latency_ms, case when p_hold_reason is null then null else now() end)
  on conflict (inbound_message_id) do nothing
  returning id into v_id;
  if v_id is null then return 'duplicate'; end if;
  if p_hold_reason is not null then
    v_hold := public.routing_v2_write_hold(r.property_id, r.inbound_message_id, p_hold_reason, 'safety');
    if v_hold not in ('held', 'upgraded', 'already_held') then
      raise exception 'routing_v2_record_live_decision: safety hold not written (%)', v_hold;
    end if;
    update public.sequence_enrollments set status = 'paused', pause_reason = 'held_for_person', updated_at = now()
      where property_id = r.property_id and routing_v2_engine = 'v2' and status = 'active';
    update public.routing_v2_outbox set status = 'cancelled', cancel_reason = 'held_for_person'
      where property_id = r.property_id and kind = 'reply' and status = 'pending';
  end if;
  return 'recorded';
end;
$$;
revoke all on function public.routing_v2_record_live_decision(jsonb,text) from public, anon, authenticated;
grant execute on function public.routing_v2_record_live_decision(jsonb,text) to service_role;

-- B. A hold that ends (a person resolved it) fulfilled every older safety obligation of the lead:
--    its decisions' effects are recorded and its hold-failed claims are resolved, so the gate
--    lets the lead's next text route normally (never a time exit).
create or replace function public.routing_v2_hold_cleared_resolves()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(old.needs_human_attention, false) = true and coalesce(new.needs_human_attention, false) = false then
    update public.routing_v2_live_decisions set effects_applied_at = now()
      where property_id = new.id and effects_applied_at is null;
    update public.ai_response_claims set error_message = 'v2_safety_hold_resolved', updated_at = now()
      where property_id = new.id and response_kind = 'sms_ai_responder_v1'
        and status = 'error' and error_message = 'v2_safety_hold_failed';
  end if;
  return null;
end;
$$;
revoke all on function public.routing_v2_hold_cleared_resolves() from public, anon, authenticated;
drop trigger if exists trg_routing_v2_hold_cleared_resolves on public.properties;
create trigger trg_routing_v2_hold_cleared_resolves after update of needs_human_attention on public.properties
  for each row execute function public.routing_v2_hold_cleared_resolves();

-- C. Claim leases on the DB clock: a new claim (or a reclaim, which sets claimed_at) takes the DB's
--    now() and keeps the app's lease length; releasing a lease never sets it later than now().
create or replace function public.ai_response_claims_db_clock()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_len interval;
begin
  if tg_op = 'INSERT' or new.claimed_at is distinct from old.claimed_at then
    v_len := coalesce(new.lease_expires_at - new.claimed_at, interval '0');
    if v_len < interval '0' then v_len := interval '0'; end if;
    new.claimed_at := now();
    new.lease_expires_at := now() + v_len;
  elsif new.lease_expires_at is distinct from old.lease_expires_at and new.lease_expires_at is not null then
    new.lease_expires_at := least(new.lease_expires_at, now());
  end if;
  return new;
end;
$$;
revoke all on function public.ai_response_claims_db_clock() from public, anon, authenticated;
drop trigger if exists trg_ai_response_claims_db_clock on public.ai_response_claims;
create trigger trg_ai_response_claims_db_clock before insert or update on public.ai_response_claims
  for each row execute function public.ai_response_claims_db_clock();

-- The DB clock for app-side comparisons that read DB-written times (send gate, claim freshness).
create or replace function public.routing_v2_db_now()
returns timestamptz language sql stable security definer set search_path = public, pg_temp as $$ select now() $$;
revoke all on function public.routing_v2_db_now() from public, anon, authenticated;
grant execute on function public.routing_v2_db_now() to service_role;

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
  v_hold_at timestamptz;
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

  -- 20261031131600 (A-2 race analysis F2 / F4), under the property advisory lock and the row lock:
  -- * a hold about OUR OWN earlier reply that could not go out ('mechanics'), from an inbound
  --   older than this one, yields to this newer text: it is cleared (audited) and the text is
  --   routed fresh (newest wins; Jarrad Q1 default);
  -- * any other hold (the seller's words, a person, or a legacy hold with no kind) stays: no
  --   reply and no drip start; the owner alerts are kept (outcome 'held').
  -- 20261031132200 (Astra review of b6a00a0a2f17, P1-1 / P1-2): an OLDER text of this lead with an
  -- UNRECOVERED safety obligation blocks this newer text, whatever its claim state and however old:
  --  * a safety decision (possible stop, hold, failed classification) whose effects never landed
  --    (effects_applied_at null: only rows from before the atomic recorder, or its fallback), or
  --  * a v2 safety hold that could not be written at all (claim error v2_safety_hold_failed).
  -- The only exits: the sweep handled it (its mark), or its effects were recorded (a hold that a
  -- person has since cleared counts: clearing a hold records them). No time exit.
  if exists (
    select 1 from public.messages om
    where om.property_id = p_property_id and om.direction = 'inbound' and om.id <> p_inbound_message_id
      and (om.created_at < msg.created_at or (om.created_at = msg.created_at and om.id < msg.id))
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
    return public.routing_v2_record_alerts_only(p_inbound_message_id,p_property_id,p_decision,'held')
      || jsonb_build_object('outcome', 'held');
  end if;
  if prop.needs_human_attention then
    if prop.hold_kind = 'mechanics' and prop.hold_inbound_message_id is not null then
      select m.created_at into v_hold_at from public.messages m where m.id = prop.hold_inbound_message_id;
    end if;
    if prop.hold_kind = 'mechanics' and v_hold_at is not null
       and (v_hold_at < msg.created_at or (v_hold_at = msg.created_at and prop.hold_inbound_message_id < msg.id)) then
      update public.properties set needs_human_attention = false where id = p_property_id;
      insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
      values (evidence.org_id, p_property_id, 'system', 'ai_escalation_cleared', jsonb_build_object(
        'reason', 'mechanics_hold_superseded', 'cleared_hold_reason', prop.last_ai_escalation_reason,
        'hold_inbound_message_id', prop.hold_inbound_message_id, 'by_inbound_message_id', p_inbound_message_id));
    else
      return public.routing_v2_record_alerts_only(p_inbound_message_id,p_property_id,p_decision,'held')
        || jsonb_build_object('outcome', 'held');
    end if;
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

drop function if exists public.routing_v2_sweep_candidates(integer,integer);
create or replace function public.routing_v2_sweep_candidates(p_lease_seconds integer, p_limit integer default 50, p_property_id uuid default null)
returns table (id uuid, org_id uuid, property_id uuid, conversation_id uuid, why text, created_at timestamptz)
language sql stable security definer set search_path = public, pg_temp
as $$
  select m.id, m.org_id, m.property_id, m.conversation_id,
    case
      when c.status = 'error' and c.error_message = 'v2_safety_hold_failed' then 'safety_hold_failed'
      when u.unrecovered then 'decision_unrecovered'
      when c.status = 'error' then 'hold_failed'
      when m.metadata->'processing'->'aiResponder' is null then 'unstamped'
      when c.status = 'processing' then 'claim_expired'
      else 'delayed_stale'
    end,
    m.created_at
  from public.messages m
  left join public.ai_response_claims c on c.inbound_message_id = m.id and c.response_kind = 'sms_ai_responder_v1'
  cross join lateral (select exists (
      select 1 from public.routing_v2_live_decisions d
      where d.inbound_message_id = m.id and d.effects_applied_at is null and d.status in ('decided','failed')
        and (d.status = 'failed' or d.action is null or d.action->>'road' = 'stop'
           or (d.action->>'road' is distinct from 'bad_number'
               and exists (select 1 from jsonb_array_elements(coalesce(d.action->'steps', '[]'::jsonb)) s where s->>'kind' = 'hold')
               and not exists (select 1 from jsonb_array_elements(coalesce(d.action->'steps', '[]'::jsonb)) s where s->>'kind' = 'wrong_number_close')))) as unrecovered) u
  where m.direction = 'inbound' and m.channel = 'sms' and m.property_id is not null
    and (p_property_id is null or m.property_id = p_property_id)
    and m.metadata->>'keyword' is null
    and m.metadata->'processing'->'routingV2Sweep' is null
    and (
      -- 20261031132200 (Astra P1-1): an unrecovered safety obligation never ages out of the sweep
      -- (the app reports one older than a day); a run whose lease is still live is left alone.
      ((u.unrecovered or (c.status = 'error' and c.error_message = 'v2_safety_hold_failed'))
        and not coalesce(c.status = 'processing' and c.lease_expires_at > now(), false))
      or (m.created_at > now() - interval '24 hours'
        and (c.status = 'processing'
             or (c.status = 'error' and c.error_message = 'flag_failed')
             or not exists (select 1 from public.routing_v2_live_decisions d where d.inbound_message_id = m.id))
        and (
          (m.metadata->'processing'->'aiResponder' is null and c.id is null
            and m.created_at < now() - make_interval(secs => p_lease_seconds))
          -- Round 17 (C): a first delay (no claim yet) is aged from the text's own created_at plus
          -- its delay (DB clock), not from the webhook's app-clock scheduledAt.
          or (m.metadata->'processing'->'aiResponder'->>'outcome' = 'delayed' and c.id is null
            and coalesce(m.created_at + make_interval(secs => nullif(m.metadata->'processing'->'aiResponder'->>'delaySeconds','')::int),
                         (m.metadata->'processing'->'aiResponder'->>'scheduledAt')::timestamptz)
                < now() - make_interval(secs => p_lease_seconds))
          or (c.status = 'processing' and c.lease_expires_at < now() - make_interval(secs => p_lease_seconds))
          or (c.status = 'error' and c.error_message = 'flag_failed'
              and c.updated_at < now() - make_interval(secs => p_lease_seconds)
              and not coalesce((select p.needs_human_attention from public.properties p where p.id = m.property_id), false)
              and exists (select 1 from public.routing_v2_live_decisions d
                          where d.inbound_message_id = m.id and d.status in ('decided','failed') and (d.status = 'failed' or d.action is null or d.action->>'road' = 'stop'
           or (d.action->>'road' is distinct from 'bad_number'
               and exists (select 1 from jsonb_array_elements(coalesce(d.action->'steps', '[]'::jsonb)) s where s->>'kind' = 'hold')
               and not exists (select 1 from jsonb_array_elements(coalesce(d.action->'steps', '[]'::jsonb)) s where s->>'kind' = 'wrong_number_close')))))))
    )
  order by m.created_at
  limit greatest(least(coalesce(p_limit, 50), 200), 1);
$$;
revoke all on function public.routing_v2_sweep_candidates(integer,integer,uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_sweep_candidates(integer,integer,uuid) to service_role;

create or replace function public.routing_v2_mark_inbound_swept(p_message_id uuid, p_result text)
returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_marked boolean;
begin
  -- 20261031132200: also allowed on a text with an unrecovered safety obligation; a 'held' mark
  -- records the decision's effects as applied (in the same transaction) and closes a dead claim.
  with u as (
    update public.messages
      set metadata = jsonb_set(
        jsonb_set(coalesce(metadata, '{}'::jsonb), '{processing}', coalesce(metadata->'processing', '{}'::jsonb), true),
        '{processing,routingV2Sweep}', jsonb_build_object('at', now(), 'result', p_result), true)
      where id = p_message_id
        and (metadata->'processing'->'aiResponder' is null or metadata->'processing'->'aiResponder'->>'outcome' = 'delayed'
             or exists (select 1 from public.ai_response_claims c
                        where c.inbound_message_id = p_message_id and c.response_kind = 'sms_ai_responder_v1'
                          and (c.status = 'processing' or (c.status = 'error' and c.error_message in ('flag_failed','v2_safety_hold_failed'))))
             or exists (select 1 from public.routing_v2_live_decisions d where d.inbound_message_id = p_message_id and d.effects_applied_at is null))
      returning 1
  ) select exists (select 1 from u) into v_marked;
  if v_marked and p_result = 'held' then
    update public.ai_response_claims
      set status = 'error', error_message = 'lease_dead_swept', updated_at = now()
      where inbound_message_id = p_message_id and response_kind = 'sms_ai_responder_v1' and status = 'processing';
    update public.routing_v2_live_decisions set effects_applied_at = now()
      where inbound_message_id = p_message_id and effects_applied_at is null;
  end if;
  return v_marked;
end;
$$;
revoke all on function public.routing_v2_mark_inbound_swept(uuid,text) from public, anon, authenticated;
grant execute on function public.routing_v2_mark_inbound_swept(uuid,text) to service_role;

commit;
