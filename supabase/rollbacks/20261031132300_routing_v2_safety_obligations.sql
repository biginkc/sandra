-- Rollback of 20261031132300: restores the previous bodies and the 132200 hold-cleared trigger;
-- drops the obligation store and its functions / triggers (open obligations are lost: their leads
-- fall back to the 132200 gate).
begin;
set local lock_timeout = '5s';
drop trigger if exists trg_routing_v2_hold_obligation_keep on public.properties;
drop function if exists public.routing_v2_hold_obligation_keep();
drop trigger if exists trg_routing_v2_suppression_resolves_obligations on public.properties;
drop function if exists public.routing_v2_suppression_resolves_obligations();
create or replace function public.routing_v2_write_hold(
  p_property_id uuid, p_inbound_message_id uuid, p_reason text, p_kind text
) returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
  prop public.properties;
begin
  if p_kind not in ('mechanics','safety') then raise exception 'routing_v2_write_hold: bad kind %', p_kind; end if;
  if coalesce(p_reason,'') = '' then raise exception 'routing_v2_write_hold: reason required'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || p_property_id::text));
  select * into prop from public.properties where id = p_property_id for update;
  if not found then return 'missing'; end if;
  if p_kind = 'mechanics' then
    -- Only about our own reply: a newer seller text owns the thread; it is routed by itself.
    select created_at into v_at from public.messages where id = p_inbound_message_id;
    if v_at is null or exists (
      select 1 from public.messages m where m.property_id = p_property_id and m.direction = 'inbound'
        and (m.created_at > v_at or (m.created_at = v_at and m.id > p_inbound_message_id))
    ) then
      return 'superseded';
    end if;
  end if;
  if prop.needs_human_attention then
    -- Never overwrite a hold; a safety hold on top of a mechanics hold upgrades its kind so a
    -- newer text can no longer clear it.
    if p_kind = 'safety' and prop.hold_kind = 'mechanics' then
      update public.properties set hold_kind = 'safety', last_ai_escalation_reason = p_reason,
        hold_inbound_message_id = p_inbound_message_id where id = p_property_id;
      return 'upgraded';
    end if;
    return 'already_held';
  end if;
  update public.properties
    set needs_human_attention = true, last_ai_escalation_reason = p_reason, last_ai_escalation_at = now(),
        updated_at = now(), hold_kind = p_kind, hold_inbound_message_id = p_inbound_message_id
    where id = p_property_id;
  return 'held';
end;
$$;
revoke all on function public.routing_v2_write_hold(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.routing_v2_write_hold(uuid,uuid,text,text) to service_role;

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

create or replace function public.routing_v2_enrollment_send_check(p_enrollment_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments;
  v_takeover timestamptz;
  v_anchor timestamptz;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if not found then return 'missing'; end if;
  if e.routing_v2_engine is distinct from 'v2' then
    -- Legacy enrollment: untouched, unless it points at a v2 drip (only routing v2 may enroll
    -- there; anything else would send approved texts with no flag/canary/takeover check).
    if not exists (select 1 from public.sequences s where s.id = e.sequence_id and s.routing_v2_key is not null) then
      return 'ok';
    end if;
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || e.property_id::text));
    select * into e from public.sequence_enrollments where id = p_enrollment_id;
    if e.status <> 'active' then return 'not_active'; end if;
    if coalesce((select is_dnc_locked from public.properties where id = e.property_id), false) then
      update public.sequence_enrollments
      set status = 'opted_out', pause_reason = 'dnc', next_run_at = null, updated_at = now()
      where id = e.id and status = 'active';
      return 'suppressed';
    end if;
    update public.sequence_enrollments
    set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now(), ended_reason = 'flag_off'
    where id = e.id and status = 'active';
    return 'flag_off';
  end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || e.property_id::text));
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if e.status <> 'active' then return 'not_active'; end if;

  -- DNC lock first: the only write the lock trigger allows is the compliance opt-out.
  if coalesce((select is_dnc_locked from public.properties where id = e.property_id), false) then
    update public.sequence_enrollments
    set status = 'opted_out', pause_reason = 'dnc', next_run_at = null, updated_at = now()
    where id = e.id and status = 'active';
    return 'suppressed';
  end if;

  if not public.routing_v2_slice_enabled(e.property_id, 'drips') then
    update public.sequence_enrollments
    set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now(), ended_reason = 'flag_off'
    where id = e.id and status = 'active';
    return 'flag_off';
  end if;
  select last_person_takeover_at into v_takeover from public.properties where id = e.property_id;
  -- 20261031131600 (stress §14): a person who took over AFTER the seller's text that started this
  -- drip owns the lead, even when the takeover was stamped before the enrollment committed (the
  -- takeover waited on the routing commit, or carried an earlier clock). Compared against that
  -- inbound's DB time; legacy rows with no inbound keep the enrollment time.
  select least(e.enrolled_at, m.created_at) into v_anchor
    from (select 1) one left join public.messages m on m.id = e.routing_v2_inbound_id;
  if v_takeover is not null and v_takeover >= coalesce(v_anchor, e.enrolled_at) then
    update public.sequence_enrollments
    set status = 'paused', pause_reason = 'person_took_over', next_run_at = null, updated_at = now()
    where id = e.id and status = 'active';
    return 'person_took_over';
  end if;
  -- 20261031131500: a lead held for a person (needs_human_attention: a possible stop, a legal /
  -- keyword hold, a reply that could not be sent...) gets no drip text. Checked here, under the
  -- property lock right before every v2 drip send, so no path that writes a hold (outbox,
  -- webhook keyword / legal, a racing decision) can leave a drip texting a held lead. The drip is
  -- paused for the person (as the webhook pauses it); the person decides what happens next.
  if coalesce((select needs_human_attention from public.properties where id = e.property_id), false) then
    update public.sequence_enrollments
    set status = 'paused', pause_reason = 'inbound_reply', updated_at = now()
    where id = e.id and status = 'active';
    return 'held_for_person';
  end if;
  -- 20261031131600 (F5): a v2 drip waits for its own road's reply. While the reply queued by the
  -- inbound that enrolled this drip is still pending / claimed, no drip step goes out (the
  -- enrollment stays active; the tick looks again shortly).
  if e.routing_v2_inbound_id is not null and exists (
    select 1 from public.routing_v2_outbox o
    where o.kind = 'reply' and o.inbound_message_id = e.routing_v2_inbound_id
      -- 20261031132000 (Astra P1 #2): a reply cancelled with its hold still to be written (the
      -- person handoff) blocks the drip too, until that hold lands (then the held check pauses it).
      and (o.status in ('pending','claimed') or (o.status = 'cancelled' and o.hold_pending))
  ) then
    return 'reply_pending';
  end if;
  if public.routing_v2_contact_suppressed(e.property_id, e.contact_id) then
    update public.sequence_enrollments
    set status = 'paused', pause_reason = 'consent_revoked', next_run_at = null, updated_at = now()
    where id = e.id and status = 'active';
    return 'suppressed';
  end if;
  return 'ok';
end;
$$;
revoke all on function public.routing_v2_enrollment_send_check(uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_enrollment_send_check(uuid) to service_role;

create or replace function public.routing_v2_check_authorized_outbox_send(p_outbox_id uuid, p_property_id uuid, p_inbound_message_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_outbox;
  v_latest bigint;
  v_inbound_at timestamptz;
  v_contact uuid;
  v_takeover timestamptz;
  v_locked boolean;
  v_held boolean;
  v_reason text;
begin
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if not found then return 'missing'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.property_id::text));
  select * into v from public.routing_v2_outbox where id = p_outbox_id for update;
  if v.status <> 'claimed' then return 'not_claimed'; end if;
  if v.authorized_at is null then return 'not_authorized'; end if;
  if v.property_id is distinct from p_property_id or v.inbound_message_id is distinct from p_inbound_message_id then return 'identity_mismatch'; end if;

  select max(transition_seq) into v_latest from public.routing_v2_reply_transitions
  where property_id = v.property_id and outcome <> 'superseded';
  select inbound_at into v_inbound_at from public.routing_v2_reply_transitions
  where inbound_message_id = v.inbound_message_id;
  select contact_id into v_contact from public.messages where id = v.inbound_message_id;
  select last_person_takeover_at, coalesce(is_dnc_locked, true), coalesce(needs_human_attention, false)
    into v_takeover, v_locked, v_held
  from public.properties where id = v.property_id;

  if v.kind = 'alert' and v.payload->'when_time_only_off' = 'true'::jsonb
     and public.routing_v2_slice_enabled(v.property_id,'drips')
     and public.routing_v2_slice_enabled(v.property_id,'alert_on_time_only') then
    v_reason := 'time_only_alert_disabled';
  elsif v.kind = 'reply' and v_latest is distinct from v.transition_seq then
    v_reason := 'superseded';
  elsif v.kind = 'reply' and exists(select 1 from public.messages newer join public.messages source on source.id=v.inbound_message_id where newer.property_id=v.property_id and newer.direction='inbound' and (newer.created_at>source.created_at or (newer.created_at=source.created_at and newer.id>source.id))) then
    v_reason := 'superseded';
  elsif v.kind = 'reply' and v_takeover is not null and (v_inbound_at is null or v_takeover >= v_inbound_at) then
    v_reason := 'human_takeover';
  elsif v.kind = 'reply' and (coalesce(v_locked, true) or public.routing_v2_contact_suppressed(v.property_id, v_contact)) then
    v_reason := 'suppressed';
  -- 20261031131900 (Astra review of 921b71c2a133, P1): a lead held for a person (any hold, committed
  -- after the app's last read) gets no automatic reply; read here under the routing lock, right
  -- before the provider. Owner alerts are not refused by a hold.
  elsif v.kind = 'reply' and v_held then
    v_reason := 'held_for_person';
  -- 20261031132000 (Astra P2 #3): a reply older than 24 hours (DB clock) is never sent late; a
  -- person looks instead (hold_pending, written by the app or the cron).
  elsif v.kind = 'reply' and now() - v.created_at > interval '24 hours' then
    v_reason := 'expired';
  elsif v.engine is distinct from 'v2' or not public.routing_v2_slice_enabled(v.property_id, v.slice) then
    v_reason := 'flag_off';
  end if;

  if v_reason is not null then
    update public.routing_v2_outbox set status = 'cancelled', cancel_reason = v_reason,
      hold_pending = (v_reason = 'expired') or hold_pending where id = v.id;
    return v_reason;
  end if;
  return 'ok';
end;
$$;
revoke all on function public.routing_v2_check_authorized_outbox_send(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.routing_v2_check_authorized_outbox_send(uuid,uuid,uuid) to service_role;

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

drop function if exists public.routing_v2_obligation_candidates(integer,uuid);
drop function if exists public.routing_v2_resolve_obligations_by_person(uuid);
drop function if exists public.routing_v2_resolve_obligation_hold_durable(uuid,uuid,text);
drop function if exists public.routing_v2_open_obligation(uuid,uuid,text,text);
drop function if exists public.routing_v2_has_unresolved_obligation(uuid);
drop table if exists public.routing_v2_safety_obligations;
commit;
