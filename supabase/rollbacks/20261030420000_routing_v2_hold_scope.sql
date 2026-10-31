-- Rollback of 20261030420000: restore routing_v2_apply_live_transition (20261030310000) and
-- routing_v2_enrollment_send_check (20261030410000) exactly; drop the hold-scope writer, the
-- triggers, the sweep helpers and the two columns. Drips the trigger paused stay paused
-- (held_for_person), the same state as any held lead; a person decides.
begin;
set local lock_timeout = '5s';
drop trigger if exists trg_routing_v2_hold_pauses_drips on public.properties;
drop trigger if exists trg_routing_v2_hold_scope_clear on public.properties;
drop function if exists public.routing_v2_hold_pauses_drips();
drop function if exists public.routing_v2_hold_scope_clear();
drop function if exists public.routing_v2_write_hold(uuid,uuid,text,text);
drop function if exists public.routing_v2_mechanics_hold_yields(uuid,uuid);
drop function if exists public.routing_v2_sweep_candidates(integer,integer);
drop function if exists public.routing_v2_mark_inbound_swept(uuid,text);
drop function if exists public.routing_v2_mark_person_takeover(uuid[]);

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

create or replace function public.routing_v2_enrollment_send_check(p_enrollment_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments;
  v_takeover timestamptz;
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
  if v_takeover is not null and v_takeover >= e.enrolled_at then
    update public.sequence_enrollments
    set status = 'paused', pause_reason = 'person_took_over', next_run_at = null, updated_at = now()
    where id = e.id and status = 'active';
    return 'person_took_over';
  end if;
  -- 20261030410000: a lead held for a person (needs_human_attention: a possible stop, a legal /
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

alter table public.properties drop constraint if exists properties_hold_kind_check;
alter table public.properties drop column if exists hold_kind, drop column if exists hold_inbound_message_id;
commit;
