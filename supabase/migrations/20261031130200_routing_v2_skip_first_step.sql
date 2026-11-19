-- Ordered after routing-v2 snapshots. Preserve every PR-F guard; add atomic skip-first support.
begin;
set local lock_timeout = '5s';
create or replace function public.route_reply_transition(
  p_inbound_message_id uuid,
  p_property_id uuid,
  p_decision jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.routing_v2_reply_transitions;
  v_row public.routing_v2_reply_transitions;
  v_org uuid;
  v_inbound_at timestamptz;
  v_contact uuid;
  v_seq bigint;
  v_outcome text;
  v_key text := nullif(p_decision->>'sequence_key', '');
  v_sequence uuid;
  v_new_enrollment uuid;
  v_retired uuid[] := '{}';
  v_cancelled uuid[] := '{}';
  v_cancelled_claims uuid[] := '{}';
  v_takeover timestamptz;
  v_locked boolean;
  v_drips boolean;
  v_item jsonb;
  v_skip_first boolean := coalesce((p_decision->>'skip_first_step')::boolean, false);
  v_start_delay integer;
begin
  -- 1. Serialize every reply / takeover / scheduler step for this property.
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || p_property_id::text));

  -- 2. Idempotency: a repeat call returns the stored result with no side effects.
  select * into v_existing from public.routing_v2_reply_transitions
  where inbound_message_id = p_inbound_message_id;
  if found then
    return to_jsonb(v_existing) || jsonb_build_object('replayed', true);
  end if;

  select m.org_id, m.created_at, m.contact_id into v_org, v_inbound_at, v_contact
  from public.messages m
  where m.id = p_inbound_message_id and m.direction = 'inbound' and m.property_id = p_property_id;
  if v_org is null then
    raise exception 'ROUTING_V2_BAD_INBOUND: % is not an inbound message for property %',
      p_inbound_message_id, p_property_id;
  end if;
  v_contact := coalesce(nullif(p_decision->>'contact_id','')::uuid, v_contact);

  select coalesce(max(transition_seq), 0) + 1 into v_seq
  from public.routing_v2_reply_transitions where property_id = p_property_id;

  -- 3. Latest reply wins: a newer inbound already transitioned -> record only.
  if exists (
    select 1 from public.routing_v2_reply_transitions t
    where t.property_id = p_property_id and t.outcome <> 'superseded'
      and (t.inbound_at > v_inbound_at
           or (t.inbound_at = v_inbound_at and t.inbound_message_id > p_inbound_message_id))
  ) then
    v_outcome := 'superseded';
  elsif not (public.routing_v2_slice_enabled(p_property_id, 'drips')
              or public.routing_v2_slice_enabled(p_property_id, 'replies')) then
    -- Each slice works on its own: only when NEITHER drips nor replies is on is it record-only.
    v_outcome := 'flag_off';
  end if;

  if v_outcome is null then
    select coalesce(is_dnc_locked, false) into v_locked from public.properties where id = p_property_id;
    v_drips := public.routing_v2_slice_enabled(p_property_id, 'drips')
      and (not coalesce((p_decision->>'stop_drip_when_time_only_on')::boolean,false)
        or public.routing_v2_slice_enabled(p_property_id, 'alert_on_time_only'));

    -- 4. Retire every active OR paused enrollment for the property (any engine). Drips slice
    --    only: with drips off, existing drips are left exactly as they are.
    if not v_drips then
      null;
    elsif v_locked then
      -- DNC-locked property: guard_locked_property_sequence_enrollment only allows the exact
      -- compliance stop (active/paused -> opted_out, pause_reason dnc, next_run_at null, no
      -- other column). Anything else raises DNC_LOCKED and would roll back the transition.
      with retired as (
        update public.sequence_enrollments e
        set status = 'opted_out', pause_reason = 'dnc', next_run_at = null, updated_at = now()
        where e.property_id = p_property_id and e.status in ('active','paused')
        returning e.id
      ) select coalesce(array_agg(id), '{}') into v_retired from retired;
    else
      with retired as (
        update public.sequence_enrollments e
        set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now(),
            ended_reason = 'rerouted', retired_by_inbound_id = p_inbound_message_id
        where e.property_id = p_property_id and e.status in ('active','paused')
        returning e.id
      ) select coalesce(array_agg(id), '{}') into v_retired from retired;
    end if;

    -- 4b. Open drip send claims for the property are cancelled (reply-vs-tick race).
    if v_drips then
      with cc as (
        update public.routing_v2_drip_send_claims dc
        set status = 'cancelled', cancel_reason = 'retired_by=' || p_inbound_message_id::text, cancelled_at = now()
        where dc.property_id = p_property_id and dc.status = 'open'
        returning dc.id
      ) select coalesce(array_agg(id), '{}') into v_cancelled_claims from cc;
    end if;

    -- 6. Obsolete intents from older inbounds are cancelled: auto replies to the seller ONLY.
    --    (PR-F) An alert to the owner is never cancelled by a newer seller reply.
    with c as (
      update public.routing_v2_outbox o
      set status = 'cancelled', cancel_reason = 'superseded_by=' || p_inbound_message_id::text
      where o.property_id = p_property_id and o.status = 'pending' and o.transition_seq < v_seq
        and o.kind = 'reply'
      returning o.id
    ) select coalesce(array_agg(id), '{}') into v_cancelled from c;

    select last_person_takeover_at into v_takeover from public.properties where id = p_property_id;

    if v_locked then
      v_outcome := 'suppressed';
    elsif v_takeover is not null and v_takeover >= v_inbound_at then
      v_outcome := 'takeover_blocked';
    elsif public.routing_v2_contact_suppressed(p_property_id, v_contact) then
      v_outcome := 'suppressed';
    elsif not v_drips then
      v_outcome := 'replies_only';  -- reply/alert intents only; no drip change
    else
      v_outcome := 'applied';
      if v_key is not null then
        v_sequence := public.routing_v2_sequence_for(v_org, v_key);
        if v_sequence is null or (v_skip_first and not exists (
          select 1 from public.sequence_steps where sequence_id=v_sequence and step_index=1
        )) then
          v_outcome := 'no_sequence';
        else
          v_new_enrollment := public.routing_v2_enroll(v_org, p_property_id, v_contact, v_sequence, p_inbound_message_id);
          if v_skip_first then
            -- Same start delay as legacy enrollLead(skipFirstStep). Atomic with retirement,
            -- enrollment and intents under the property lock; step zero is never claimable.
            select delay_after_previous_minutes into v_start_delay
              from public.sequence_steps where sequence_id=v_sequence and step_index=1;
            update public.sequence_enrollments set current_step_index=1,
              next_run_at=now()+make_interval(mins=>v_start_delay)
              where id=v_new_enrollment;
          end if;
        end if;
      end if;
    end if;

    -- 5. Outbound intents. Takeover / suppression: alerts only, never an auto reply.
    for v_item in select * from jsonb_array_elements(coalesce(p_decision->'outbox', '[]'::jsonb)) loop
      if ((v_item->>'kind') = 'alert' or v_outcome in ('applied','replies_only','no_sequence'))
         and public.routing_v2_slice_enabled(p_property_id, coalesce(nullif(v_item->>'slice',''), 'replies')) then
        -- Each intent only when its own slice is on (drips on / replies off: enrollment only).
        insert into public.routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice, payload)
        values (v_org, p_property_id, p_inbound_message_id, v_seq, v_item->>'kind', 'v2',
                coalesce(nullif(v_item->>'slice',''), 'replies'),
                coalesce(v_item->'payload','{}'::jsonb));
      end if;
    end loop;
  end if;

  insert into public.routing_v2_reply_transitions
    (org_id, property_id, inbound_message_id, inbound_at, transition_seq, outcome, decision,
     new_enrollment_id, retired_enrollment_ids, cancelled_outbox_ids, cancelled_drip_claim_ids)
  values
    (v_org, p_property_id, p_inbound_message_id, v_inbound_at, v_seq, v_outcome, p_decision,
     v_new_enrollment, v_retired, v_cancelled, v_cancelled_claims)
  returning * into v_row;
  return to_jsonb(v_row) || jsonb_build_object('replayed', false);
end;
$$;

commit;
