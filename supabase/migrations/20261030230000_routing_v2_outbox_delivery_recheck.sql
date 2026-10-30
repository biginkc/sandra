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
--      * a newer, non-superseded transition exists for the property (Race A: latest wins);
--      * kind = 'reply' and a person took over at/after this row's inbound (Race B);
--      * kind = 'reply' and the property is DNC-locked or the contact is suppressed;
--      * questions_live / the row's own slice / canary eligibility is off (flag flip).
--    Alerts to the owner are still allowed after a takeover or suppression (alert intent only).
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

  if v_latest is distinct from v.transition_seq then
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

comment on column public.routing_v2_outbox.authorized_at is
  'Routing v2 (PR-F): set once by routing_v2_authorize_outbox_send right before the provider call.';

commit;
