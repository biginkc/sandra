-- 20261031140200: obligations - person resolution, honest clears, fail-closed fallback (Opus review
-- of #956 at 36321be81c39: B1, B4, N2).
--   B1  fn_resolve_hold (Messages v2 Dismiss / Take over) resolves the lead's safety obligations as
--       the person, in its own transaction, before the flag update, and reports flagCleared only
--       when the row really ended held (a trigger-kept clear is not a clear).
--   N2  A kept hold shows the reason of the oldest OPEN obligation (not the reason just resolved).
--   B4  When the obligation itself cannot be written on a failure path, a durable fallback marker
--       is written on the inbound's claim (status completed, error_message
--       'v2_safety_obligation_unrecorded'; a completed claim is never reclaimed). The one predicate
--       treats that marker as an unresolved obligation; the sweep promotes it into a real
--       obligation; a person's resolution or a suppression retires it.
-- Rollback: supabase/rollbacks/20261031140200_routing_v2_obligations_person_and_fallback.sql
begin;
set local lock_timeout = '5s';

-- B4: the one predicate also sees the fallback marker.
create or replace function public.routing_v2_has_unresolved_obligation(p_property_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.routing_v2_safety_obligations o
                 where o.property_id = p_property_id and o.resolved_at is null)
      or exists (select 1 from public.ai_response_claims c
                 where c.property_id = p_property_id and c.error_message = 'v2_safety_obligation_unrecorded');
$$;
revoke all on function public.routing_v2_has_unresolved_obligation(uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_has_unresolved_obligation(uuid) to service_role;

create index if not exists idx_ai_response_claims_obligation_unrecorded
  on public.ai_response_claims (property_id) where error_message = 'v2_safety_obligation_unrecorded';

-- B4: write the fallback marker (outcome carries the reason).
-- Astra review of dc331c85974 (B1): compare-and-set on both sides. A run marks ITS OWN claim only
-- while that claim is still its own (same id, same claimed_at as taken, not completed); if another
-- run reclaimed it meanwhile, nothing is written (that run is re-running this text) and false is
-- returned. Without a claim (the webhook keyword path) a new completed claim row is inserted, and an
-- existing claim of the inbound is never overwritten. The reclaim (claims.ts) in turn refuses a
-- completed or marked claim, so a written marker cannot be erased by a reclaim.
create or replace function public.routing_v2_mark_obligation_unrecorded(
  p_property_id uuid, p_inbound_message_id uuid, p_reason text,
  p_claim_id uuid default null, p_claimed_at timestamptz default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select p.org_id into v_org from public.properties p where p.id = p_property_id;
  if v_org is null then return false; end if;
  if p_claim_id is not null then
    if p_claimed_at is null then return false; end if;
    update public.ai_response_claims
      set status = 'completed', completed_at = now(), outcome = coalesce(p_reason, 'nine_needs_person'),
          error_message = 'v2_safety_obligation_unrecorded', updated_at = now()
      where id = p_claim_id and property_id = p_property_id and claimed_at = p_claimed_at
        and status <> 'completed' and error_message is distinct from 'v2_safety_obligation_unrecorded';
    return found;
  end if;
  if p_inbound_message_id is null then
    insert into public.ai_response_claims (org_id, response_kind, inbound_message_id, property_id, status, completed_at, outcome, error_message, lease_expires_at)
    values (v_org, 'routing_v2_obligation_fallback', null, p_property_id, 'completed', now(), coalesce(p_reason, 'nine_needs_person'), 'v2_safety_obligation_unrecorded', now());
    return true;
  end if;
  insert into public.ai_response_claims (org_id, response_kind, inbound_message_id, property_id, status, completed_at, outcome, error_message, lease_expires_at)
  values (v_org, 'sms_ai_responder_v1', p_inbound_message_id, p_property_id, 'completed', now(), coalesce(p_reason, 'nine_needs_person'), 'v2_safety_obligation_unrecorded', now())
  on conflict (inbound_message_id, response_kind) where inbound_message_id is not null do nothing;
  return found;
end;
$$;
revoke all on function public.routing_v2_mark_obligation_unrecorded(uuid,uuid,text,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.routing_v2_mark_obligation_unrecorded(uuid,uuid,text,uuid,timestamptz) to service_role;

-- B4: the sweep turns markers into real obligations (one transaction per call).
create or replace function public.routing_v2_promote_unrecorded_markers(p_limit integer default 50, p_property_id uuid default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; n integer := 0;
begin
  for c in
    select x.id, x.property_id, x.inbound_message_id, x.outcome from public.ai_response_claims x
    where x.error_message = 'v2_safety_obligation_unrecorded' and (p_property_id is null or x.property_id = p_property_id)
    order by x.created_at limit greatest(coalesce(p_limit, 50), 1)
    for update skip locked
  loop
    perform public.routing_v2_open_obligation(c.property_id, c.inbound_message_id, coalesce(c.outcome, 'nine_needs_person'), 'hold_failed');
    update public.ai_response_claims set error_message = 'v2_safety_obligation_promoted', updated_at = now() where id = c.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.routing_v2_promote_unrecorded_markers(integer,uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_promote_unrecorded_markers(integer,uuid) to service_role;

-- B1: a person's resolution also retires fallback markers.
create or replace function public.routing_v2_resolve_obligations_by_person(p_property_id uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update public.ai_response_claims set error_message = 'v2_safety_obligation_resolved_by_person', updated_at = now()
  where property_id = p_property_id and error_message = 'v2_safety_obligation_unrecorded';
  with u as (
    update public.routing_v2_safety_obligations set resolved_at = now(), resolved_by = 'person'
    where property_id = p_property_id and resolved_at is null
    returning 1
  ) select count(*)::int into n from u;
  return n;
end;
$$;
revoke all on function public.routing_v2_resolve_obligations_by_person(uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_resolve_obligations_by_person(uuid) to service_role;

create or replace function public.routing_v2_suppression_resolves_obligations()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(old.is_dnc_locked, false) = false and coalesce(new.is_dnc_locked, false) = true then
    update public.routing_v2_safety_obligations set resolved_at = now(), resolved_by = 'suppression'
    where property_id = new.id and resolved_at is null;
    update public.ai_response_claims set error_message = 'v2_safety_obligation_resolved_by_suppression', updated_at = now()
    where property_id = new.id and error_message = 'v2_safety_obligation_unrecorded';
  end if;
  return null;
end;
$$;
revoke all on function public.routing_v2_suppression_resolves_obligations() from public, anon, authenticated;

-- N2: a kept hold shows the oldest OPEN obligation's reason.
create or replace function public.routing_v2_hold_obligation_keep()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_open text;
begin
  if coalesce(old.needs_human_attention, false) = true and coalesce(new.needs_human_attention, false) = false
     and public.routing_v2_has_unresolved_obligation(new.id) then
    select o.reason into v_open from public.routing_v2_safety_obligations o
      where o.property_id = new.id and o.resolved_at is null order by o.created_at limit 1;
    if v_open is null then
      select c.outcome into v_open from public.ai_response_claims c
        where c.property_id = new.id and c.error_message = 'v2_safety_obligation_unrecorded' order by c.created_at limit 1;
    end if;
    new.needs_human_attention := true;
    new.last_ai_escalation_reason := coalesce(v_open, old.last_ai_escalation_reason);
    new.last_ai_escalation_at := coalesce(old.last_ai_escalation_at, now());
    new.hold_kind := 'safety';
  end if;
  return new;
end;
$$;
revoke all on function public.routing_v2_hold_obligation_keep() from public, anon, authenticated;

-- B1: Messages v2 Dismiss / Take over (body of 20261008150200 plus the two marked blocks).
create or replace function public.fn_resolve_hold(
  p_org_id uuid,
  p_property_id uuid,
  p_user_id uuid,
  p_action text,
  p_reason text default null,
  p_seen_through timestamptz default null,
  p_flag_reason text default null,
  p_flag_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_decisions integer := 0;
  v_reviews integer := 0;
  v_drafts integer := 0;
  v_cleared boolean := false;
  v_flag_cleared boolean := false;
  v_responder_changed boolean := false;
  v_superseded_reason text;
  v_cutoff timestamptz := coalesce(p_seen_through, '-infinity'::timestamptz);
  v_leased boolean;
  v_newer boolean;
begin
  if p_action not in ('dismiss', 'take_over') then
    raise exception 'INVALID_HOLD_ACTION' using errcode = '22023';
  end if;
  if p_action = 'dismiss' and v_reason is null then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.memberships m
    where m.user_id = p_user_id
      and m.org_id = p_org_id
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
      and (m.role = 'owner' or m.acquisitions_enabled = true)
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.id, p.org_id, p.needs_human_attention, p.ai_responder_disabled,
         p.last_ai_escalation_reason, p.last_ai_escalation_at
    into v_property
  from public.properties p
  where p.id = p_property_id
  for update;
  if not found or v_property.org_id <> p_org_id then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The per-property lease (same table the send path leases from). Held until
  -- this transaction ends: the delete at the bottom rolls back with it on error.
  insert into public.ai_send_reservations as r (
    conversation_id, holder, inbound_message_id, expires_at, created_at
  ) values (
    p_property_id, 'resolve_hold:' || p_user_id::text, null,
    clock_timestamp() + interval '60 seconds', clock_timestamp()
  )
  on conflict (conversation_id) do update
    set holder = excluded.holder,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    where r.expires_at <= clock_timestamp();
  get diagnostics v_leased = row_count;
  if not v_leased then
    raise exception 'SEND_IN_PROGRESS' using errcode = '55P03';
  end if;

  -- Stale view: anything pending that the card did not display, or a flag that
  -- is no longer the one it displayed.
  v_newer :=
    exists (select 1 from public.jev_lead_decisions d
            where d.property_id = p_property_id and d.org_id = p_org_id
              and d.status = 'pending' and d.created_at > v_cutoff)
    or exists (select 1 from public.ai_disposition_reviews r2
               where r2.property_id = p_property_id and r2.org_id = p_org_id
                 and r2.status = 'pending' and r2.created_at > v_cutoff)
    or exists (select 1 from public.ai_reply_drafts x
               where x.property_id = p_property_id and x.org_id = p_org_id
                 and x.status = 'pending' and x.created_at > v_cutoff)
    or (
      v_property.needs_human_attention
      and (
        v_property.last_ai_escalation_reason is distinct from p_flag_reason
        or v_property.last_ai_escalation_at is distinct from p_flag_at
      )
    );
  if v_newer then
    delete from public.ai_send_reservations
    where conversation_id = p_property_id and holder = 'resolve_hold:' || p_user_id::text;
    return jsonb_build_object('status', 'STALE', 'action', p_action);
  end if;

  v_superseded_reason := case p_action when 'dismiss' then 'hold_dismissed' else 'hold_taken_over' end;

  update public.jev_lead_decisions d
  set status = 'superseded',
      resolved_at = now(),
      superseded_reason = v_superseded_reason
  where d.property_id = p_property_id
    and d.org_id = p_org_id
    and d.status = 'pending'
    and d.created_at <= v_cutoff;
  get diagnostics v_decisions = row_count;

  update public.ai_disposition_reviews r
  set status = 'superseded',
      resolved_at = now(),
      superseded_reason = v_superseded_reason
  where r.property_id = p_property_id
    and r.org_id = p_org_id
    and r.status = 'pending'
    and r.created_at <= v_cutoff;
  get diagnostics v_reviews = row_count;

  update public.ai_reply_drafts x
  set status = 'discarded',
      resolved_by = p_user_id,
      resolved_at = now(),
      resolution_reason = case p_action
        when 'dismiss' then 'dismissed: ' || v_reason
        else 'taken_over'
      end
  where x.property_id = p_property_id
    and x.org_id = p_org_id
    and x.status = 'pending'
    and x.created_at <= v_cutoff;
  get diagnostics v_drafts = row_count;

  -- 20261031140200 (Opus B1 on #956): a person's Dismiss / Take over of the hold they saw is the
  -- person resolution of this lead's safety obligations, in this same transaction; otherwise the
  -- obligation keep trigger would silently put the hold back. Only when the hold the card showed
  -- is the one being cleared (never on a stale card, never on a lead that is not held).
  if v_property.needs_human_attention
     and v_property.last_ai_escalation_reason is not distinct from p_flag_reason
     and v_property.last_ai_escalation_at is not distinct from p_flag_at then
    perform public.routing_v2_resolve_obligations_by_person(p_property_id);
  end if;

  -- The flag is cleared only if it is still the one the card displayed (the
  -- check above already refused a changed flag; this repeats it in the WHERE so
  -- the guard is part of the write itself).
  update public.properties p
  set needs_human_attention = false,
      last_ai_escalation_reason = null,
      last_ai_escalation_at = null,
      updated_at = now()
  where p.id = p_property_id
    and p.needs_human_attention
    and p.last_ai_escalation_reason is not distinct from p_flag_reason
    and p.last_ai_escalation_at is not distinct from p_flag_at;
  v_flag_cleared := found;
  -- A clear a trigger kept is not a clear: report what the row really says.
  if v_flag_cleared then
    select not coalesce(p.needs_human_attention, false) into v_flag_cleared
    from public.properties p where p.id = p_property_id;
  end if;

  if p_action = 'take_over' and not v_property.ai_responder_disabled then
    update public.properties p
    set ai_responder_disabled = true, updated_at = now()
    where p.id = p_property_id;
    v_responder_changed := true;
  end if;
  v_cleared := v_flag_cleared or v_responder_changed;

  delete from public.ai_send_reservations
  where conversation_id = p_property_id and holder = 'resolve_hold:' || p_user_id::text;

  return jsonb_build_object(
    'status', 'OK',
    'action', p_action,
    'decisionsSuperseded', v_decisions,
    'reviewsSuperseded', v_reviews,
    'draftsDiscarded', v_drafts,
    'propertyUpdated', v_cleared,
    'flagCleared', v_flag_cleared,
    'responderChanged', v_responder_changed,
    'wasFlagged', v_property.needs_human_attention
  );
end;
$$;

revoke all on function public.fn_resolve_hold(uuid, uuid, uuid, text, text, timestamptz, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_resolve_hold(uuid, uuid, uuid, text, text, timestamptz, text, timestamptz)
  to service_role;

comment on function public.fn_resolve_hold(uuid, uuid, uuid, text, text, timestamptz, text, timestamptz) is
  'Messages v2: Dismiss / Take over a hold atomically and version-aware (returns status STALE and changes nothing when the card is out of date). Leases the property against a concurrent Send. Service role only; re-checks owner||acquisitions for p_user_id.';

commit;
