-- Routing v2 A-2 race analysis (A2-RACE-ANALYSIS.md at ac1feacf8): the consolidated fix, DB side.
-- Ordering is decided in SQL under the existing per-property advisory lock
-- (hashtext('routing_v2:'||property_id)); no app clock, no cross-request liveness read.
-- 1. properties.hold_kind / hold_inbound_message_id: what a hold is about ('mechanics' = our own
--    reply could not go out; 'safety' = the seller's words or a person; null = a legacy hold,
--    treated as safety) and which inbound it is about. Cleared whenever the hold is cleared.
-- 2. routing_v2_write_hold: the one writer of v2 holds. A mechanics hold is written only when no
--    newer inbound exists (else 'superseded', nothing written); a safety hold is always written.
-- 3. Every hold pauses the property's v2 drips: when needs_human_attention goes false -> true,
--    from ANY writer, active v2 enrollments are paused (held_for_person). No automatic unpause.
--    No advisory lock in the trigger (the row lock serializes it against the transition).
-- 4. routing_v2_apply_live_transition: a newer text clears an older mechanics hold (audited) and
--    is routed; any other hold -> outcome 'held' (no reply, no drip start, owner alerts kept).
-- 5. routing_v2_enrollment_send_check: 'reply_pending' while the drip's own road reply is queued.
-- 6. routing_v2_mechanics_hold_yields: the early gates ask whether a hold yields to a newer text.
-- 7. routing_v2_sweep_candidates / routing_v2_mark_inbound_swept: the lease-death sweep, with
--    the age tests on the DB clock, plus stale 'delayed' stamps and expired claims; the mark is
--    written server-side with jsonb_set.
-- Rollback: supabase/rollbacks/20261031131600_routing_v2_hold_scope.sql
begin;
set local lock_timeout = '5s';

alter table public.properties
  add column if not exists hold_inbound_message_id uuid,
  add column if not exists hold_kind text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'properties_hold_kind_check') then
    alter table public.properties add constraint properties_hold_kind_check
      check (hold_kind is null or hold_kind in ('mechanics','safety'));
  end if;
end $$;

-- 1. A cleared hold carries no kind / inbound.
create or replace function public.routing_v2_hold_scope_clear()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.needs_human_attention is not true then
    new.hold_kind := null;
    new.hold_inbound_message_id := null;
  end if;
  return new;
end;
$$;
revoke all on function public.routing_v2_hold_scope_clear() from public, anon, authenticated;
drop trigger if exists trg_routing_v2_hold_scope_clear on public.properties;
create trigger trg_routing_v2_hold_scope_clear before update of needs_human_attention on public.properties
  for each row execute function public.routing_v2_hold_scope_clear();

-- 3. Every hold pauses the property's v2 drips (any writer). DNC-locked leads are skipped: their
--    drips are already stopped and the lock guard allows only the compliance stop.
create or replace function public.routing_v2_hold_pauses_drips()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(old.needs_human_attention, false) = false and new.needs_human_attention = true
     and not coalesce(new.is_dnc_locked, false) then
    update public.sequence_enrollments
      set status = 'paused', pause_reason = 'held_for_person', updated_at = now()
      where property_id = new.id and routing_v2_engine = 'v2' and status = 'active';
  end if;
  return null;
end;
$$;
revoke all on function public.routing_v2_hold_pauses_drips() from public, anon, authenticated;
drop trigger if exists trg_routing_v2_hold_pauses_drips on public.properties;
create trigger trg_routing_v2_hold_pauses_drips after update of needs_human_attention on public.properties
  for each row execute function public.routing_v2_hold_pauses_drips();

-- 2. The one writer of v2 holds.
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

-- 6. Does the property's hold yield to this (newer) inbound? Only an older mechanics hold does.
create or replace function public.routing_v2_mechanics_hold_yields(p_property_id uuid, p_inbound_message_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.properties p
      join public.messages h on h.id = p.hold_inbound_message_id
      join public.messages m on m.id = p_inbound_message_id and m.property_id = p.id
    where p.id = p_property_id and p.needs_human_attention and p.hold_kind = 'mechanics'
      and (h.created_at < m.created_at or (h.created_at = m.created_at and h.id < m.id))
  );
$$;
revoke all on function public.routing_v2_mechanics_hold_yields(uuid,uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_mechanics_hold_yields(uuid,uuid) to service_role;

-- 7. Lease-death sweep candidates, aged on the DB clock: an inbound SMS (a) with no responder
--    stamp older than the lease, (b) with a 'delayed' stamp whose scheduled time is past by more
--    than the lease, or (c) whose claim is still 'processing' with its lease expired more than
--    the lease ago; and in every case no v2 decision / audit row, no keyword exit, not yet swept.
create or replace function public.routing_v2_sweep_candidates(p_lease_seconds integer, p_limit integer default 50)
returns table (id uuid, org_id uuid, property_id uuid, conversation_id uuid, why text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select m.id, m.org_id, m.property_id, m.conversation_id,
    case
      when m.metadata->'processing'->'aiResponder' is null then 'unstamped'
      when c.status = 'processing' then 'claim_expired'
      else 'delayed_stale'
    end
  from public.messages m
  left join public.ai_response_claims c on c.inbound_message_id = m.id and c.response_kind = 'sms_ai_responder_v1'
  where m.direction = 'inbound' and m.channel = 'sms' and m.property_id is not null
    and m.created_at > now() - interval '24 hours'
    and m.metadata->>'keyword' is null
    and m.metadata->'processing'->'routingV2Sweep' is null
    and not exists (select 1 from public.routing_v2_live_decisions d where d.inbound_message_id = m.id)
    and (
      (m.metadata->'processing'->'aiResponder' is null and c.id is null
        and m.created_at < now() - make_interval(secs => p_lease_seconds))
      or (m.metadata->'processing'->'aiResponder'->>'outcome' = 'delayed' and c.id is null
        and (m.metadata->'processing'->'aiResponder'->>'scheduledAt')::timestamptz < now() - make_interval(secs => p_lease_seconds))
      or (c.status = 'processing' and c.lease_expires_at < now() - make_interval(secs => p_lease_seconds))
    )
  order by m.created_at
  limit greatest(least(coalesce(p_limit, 50), 200), 1);
$$;
revoke all on function public.routing_v2_sweep_candidates(integer,integer) from public, anon, authenticated;
grant execute on function public.routing_v2_sweep_candidates(integer,integer) to service_role;

-- The sweep's mark, server-side (no read-modify-write gap): only on a text with no completed
-- responder stamp (none, or still 'delayed').
create or replace function public.routing_v2_mark_inbound_swept(p_message_id uuid, p_result text)
returns boolean
language sql volatile security definer set search_path = public, pg_temp
as $$
  with u as (
    update public.messages
      set metadata = jsonb_set(
        jsonb_set(coalesce(metadata, '{}'::jsonb), '{processing}', coalesce(metadata->'processing', '{}'::jsonb), true),
        '{processing,routingV2Sweep}', jsonb_build_object('at', now(), 'result', p_result), true)
      where id = p_message_id
        and (metadata->'processing'->'aiResponder' is null or metadata->'processing'->'aiResponder'->>'outcome' = 'delayed')
      returning 1
  ) select exists (select 1 from u);
$$;
revoke all on function public.routing_v2_mark_inbound_swept(uuid,text) from public, anon, authenticated;
grant execute on function public.routing_v2_mark_inbound_swept(uuid,text) to service_role;

-- 4. The transition (re-created from 20261031130500 with the hold clause).
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

-- 5. The drip send check (re-created from 20261031131500 with reply_pending).
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
    where o.kind = 'reply' and o.inbound_message_id = e.routing_v2_inbound_id and o.status in ('pending','claimed')
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
commit;

-- 20261031131600 (stress §14): a person takeover stamped on the DB clock, under the same
-- per-property routing lock as the transition, so it is ordered against the routing commit:
-- before it -> the transition sees it and enrolls nothing (takeover_blocked); after it -> its
-- stamp is later than the enrollment and the send check pauses the drip.
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
