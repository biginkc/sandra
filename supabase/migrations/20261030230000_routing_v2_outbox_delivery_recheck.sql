-- SMS reply routing v2, PR-F: delivery-time re-check for routing v2 outbox rows, and the
-- human-takeover fence (BUILD-PLAN §14, Race A / Race B).
--
-- Flag-off and additive. Nothing here sends anything; no live code calls the new function
-- yet (the outbox consumer lands with the cutover PR). The takeover trigger only touches
-- routing_v2_outbox rows, which exist only while routing v2 is switched on, so with every
-- routing_v2_flags key off it changes nothing.
--
-- 1. routing_v2_outbox.authorized_at: set once, by routing_v2_authorize_outbox_send, right
--    before the provider call. A row is authorized at most once (no double send from a
--    retried consumer).
-- 2. routing_v2_authorize_outbox_send(outbox_id): the delivery-time re-check for a row the
--    consumer has ALREADY claimed (routing_v2_claim_outbox). A newer reply transition does not
--    cancel claimed rows, and a takeover can land after the claim, so the claim alone is not
--    enough. Under the property lock it refuses (and cancels) a claimed row when:
--      * kind = 'reply' and a newer, non-superseded transition exists (Race A: latest wins);
--      * kind = 'reply' and a person took over at/after this row's inbound (Race B);
--      * kind = 'reply' and the property is DNC-locked or the contact is suppressed;
--      * questions_live / the row's own slice / canary eligibility is off (flag flip).
--    Alerts to the owner are still allowed after a newer reply, a takeover or suppression; the
--    flag / canary / engine / slice checks apply to them as to every row.
-- 4. Newer-reply supersession cancels ONLY auto replies to the seller: route_reply_transition
--    step 6 and routing_v2_claim_outbox (PR-C, 20261030140000) are re-created with that one
--    change each (a "Tuesday 3pm" call-me alert is never lost because the seller adds "Thanks").
--    The rollback restores PR-C's definitions byte-for-byte.
-- 3. A takeover (properties.last_person_takeover_at moving forward: manual text, confirmed
--    new_lead, person assignment) cancels the property's still-PENDING v2 reply rows under the
--    same routing_v2 property lock, in the same transaction as the takeover marker. Claimed
--    rows are left to the delivery re-check above (they may already be in flight).
--
-- Rollback: supabase/rollbacks/20261030230000_routing_v2_outbox_delivery_recheck.sql
begin;
set local lock_timeout = '5s';

alter table public.routing_v2_outbox
  add column if not exists authorized_at timestamptz;

create or replace function public.routing_v2_authorize_outbox_send(p_outbox_id uuid)
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
  v_reason text;
begin
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if not found then return 'missing'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.property_id::text));
  select * into v from public.routing_v2_outbox where id = p_outbox_id for update;
  if v.status <> 'claimed' then return 'not_claimed'; end if;
  if v.authorized_at is not null then return 'already_authorized'; end if;

  select max(transition_seq) into v_latest from public.routing_v2_reply_transitions
  where property_id = v.property_id and outcome <> 'superseded';
  select inbound_at into v_inbound_at from public.routing_v2_reply_transitions
  where inbound_message_id = v.inbound_message_id;
  select contact_id into v_contact from public.messages where id = v.inbound_message_id;
  select last_person_takeover_at, coalesce(is_dnc_locked, true) into v_takeover, v_locked
  from public.properties where id = v.property_id;

  if v.kind = 'reply' and v_latest is distinct from v.transition_seq then
    v_reason := 'superseded';
  elsif v.kind = 'reply' and v_takeover is not null and (v_inbound_at is null or v_takeover >= v_inbound_at) then
    v_reason := 'human_takeover';
  elsif v.kind = 'reply' and (coalesce(v_locked, true) or public.routing_v2_contact_suppressed(v.property_id, v_contact)) then
    v_reason := 'suppressed';
  elsif v.engine is distinct from 'v2' or not public.routing_v2_slice_enabled(v.property_id, v.slice) then
    v_reason := 'flag_off';
  end if;

  if v_reason is not null then
    update public.routing_v2_outbox set status = 'cancelled', cancel_reason = v_reason where id = v.id;
    return v_reason;
  end if;
  update public.routing_v2_outbox set authorized_at = now() where id = v.id;
  return 'ok';
end;
$$;

revoke all on function public.routing_v2_authorize_outbox_send(uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_authorize_outbox_send(uuid) to service_role;

create or replace function public.routing_v2_takeover_fence()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Never break a takeover: if the PR-C outbox is gone (schema rolled back), do nothing.
  if to_regclass('public.routing_v2_outbox') is null then
    return new;
  end if;
  if not exists (select 1 from public.routing_v2_outbox o
                 where o.property_id = new.id and o.kind = 'reply' and o.status = 'pending') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || new.id::text));
  update public.routing_v2_outbox o
  set status = 'cancelled', cancel_reason = 'human_takeover'
  where o.property_id = new.id and o.kind = 'reply' and o.status = 'pending';
  return new;
end;
$$;

revoke all on function public.routing_v2_takeover_fence() from public, anon, authenticated;

drop trigger if exists trg_routing_v2_takeover_fence on public.properties;
create trigger trg_routing_v2_takeover_fence
  after update of last_person_takeover_at on public.properties
  for each row
  when (new.last_person_takeover_at is not null
        and new.last_person_takeover_at is distinct from old.last_person_takeover_at)
  execute function public.routing_v2_takeover_fence();

-- 4. PR-C functions, re-created with alerts exempt from newer-reply supersession.
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
    v_drips := public.routing_v2_slice_enabled(p_property_id, 'drips');

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
        if v_sequence is null then
          v_outcome := 'no_sequence';
        else
          v_new_enrollment := public.routing_v2_enroll(v_org, p_property_id, v_contact, v_sequence, p_inbound_message_id);
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

create or replace function public.routing_v2_claim_outbox(p_outbox_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_outbox;
  v_latest bigint;
  v_inbound_at timestamptz;
  v_takeover timestamptz;
  v_reason text;
begin
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if not found then return 'missing'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.property_id::text));
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if v.status <> 'pending' then return 'not_pending'; end if;

  select max(transition_seq) into v_latest from public.routing_v2_reply_transitions
  where property_id = v.property_id and outcome <> 'superseded';
  select inbound_at into v_inbound_at from public.routing_v2_reply_transitions
  where inbound_message_id = v.inbound_message_id;
  select last_person_takeover_at into v_takeover from public.properties where id = v.property_id;

  -- (PR-F) Latest reply wins for auto replies only; an owner alert survives a newer reply.
  if v.kind = 'reply' and v_latest is distinct from v.transition_seq then
    v_reason := 'superseded';
  elsif v.kind = 'reply' and v_takeover is not null and v_takeover >= v_inbound_at then
    v_reason := 'human_takeover';
  elsif v.engine is distinct from 'v2' or not public.routing_v2_slice_enabled(v.property_id, v.slice) then
    -- Every kind (alerts too): questions_live + the item's own slice + canary eligibility.
    v_reason := 'flag_off';
  end if;

  if v_reason is not null then
    update public.routing_v2_outbox set status = 'cancelled', cancel_reason = v_reason where id = v.id;
    return v_reason;
  end if;
  update public.routing_v2_outbox set status = 'claimed', claimed_at = now() where id = v.id;
  return 'ok';
end;
$$;

comment on column public.routing_v2_outbox.authorized_at is
  'Routing v2 (PR-F): set once by routing_v2_authorize_outbox_send right before the provider call.';

commit;
