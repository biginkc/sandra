-- ============================================================================
-- Migration: direct_calls
-- Created: 2026-10-01
-- Purpose: Server-side state for the direct Telnyx calling pilot
-- (.planning/direct-calling/PILOT-SPEC.md). Writes happen only from server
-- code using the service-role client; authenticated users get read-only
-- access to their own rows.
-- ============================================================================

begin;

create table if not exists public.direct_call_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null,
  telnyx_credential_id text not null,
  sip_username text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.direct_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  operator_user_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid references public.properties(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  destination_e164 text not null,
  caller_id_e164 text not null,
  status text not null default 'browser_connecting'
    check (status in ('browser_connecting', 'seller_dialing', 'connected', 'ending', 'ended', 'failed')),
  browser_leg_id text unique,
  seller_leg_id text unique,
  browser_command_id uuid not null default gen_random_uuid(),
  -- Seller Dial command state, persisted with the transition: pending -> sent | unknown.
  seller_dial_state text check (seller_dial_state in ('pending', 'sent', 'unknown')),
  hangup_cause text,
  failure_reason text,
  client_request_id uuid not null,
  -- Lead-resume obligation. Set inside direct_call_apply, atomically with the transition that makes a lead
  -- call terminal without it having connected, when no other non-terminal direct call is on the property.
  -- Worked ONLY from the operator's own authenticated session (the resume RPC refuses service-role actors);
  -- cleared once the resume function returned without throwing. resume_claimed_at is a short lease so two
  -- concurrent sessions do not both resume.
  resume_pending boolean not null default false,
  resume_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  connected_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (operator_user_id, client_request_id)
);

-- Second fence for "one live direct call per operator". The authoritative busy check is
-- direct_call_begin() below, which also counts unconfirmed cleanup obligations.
create unique index if not exists direct_calls_one_active_per_operator_idx
  on public.direct_calls (operator_user_id)
  where status not in ('ended', 'failed');

-- Every provider-side cleanup obligation is a row here, never a column on the call:
--   leg:             a leg that must be hung up until the provider confirms it is gone;
--   unresolved_dial: a Dial (browser or seller) whose outcome is not yet known. Written BEFORE the Dial,
--                    in the same transaction as the state change (call insert / seller_dial_state
--                    'pending'); resolved when the Dial's leg is learned, the provider definitively
--                    refuses it, or reconciliation proves no leg exists (see resolve_after/backstop_at).
-- Operator busy = a non-terminal direct_calls row OR any unconfirmed row here.
create table if not exists public.direct_call_cleanups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  operator_user_id uuid not null references auth.users(id) on delete cascade,
  direct_call_id uuid not null references public.direct_calls(id) on delete cascade,
  kind text not null check (kind in ('leg', 'unresolved_dial')),
  leg_id text,
  attempts integer not null default 0,
  -- Provider accepted (2xx) the hangup: stops blind resends. Not a confirmation.
  acked_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  confirmed_at timestamptz,
  -- unresolved_dial only. dial_role: which Dial. resolve_after: attempt + timeout_secs + 15s (empty
  -- listings count only from here). backstop_at: attempt + time_limit_secs + 60s (resolved by time).
  dial_role text check (dial_role in ('browser', 'seller')),
  resolve_after timestamptz,
  backstop_at timestamptz,
  -- Consecutive complete active-call listings with no match for this call's client_state.
  empty_matches integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  check ((kind = 'leg') = (leg_id is not null)),
  check ((kind = 'unresolved_dial') = (dial_role is not null))
);

create unique index if not exists direct_call_cleanups_leg_idx
  on public.direct_call_cleanups (leg_id) where leg_id is not null;
create unique index if not exists direct_call_cleanups_dial_idx
  on public.direct_call_cleanups (direct_call_id, dial_role) where kind = 'unresolved_dial';
create index if not exists direct_call_cleanups_open_idx
  on public.direct_call_cleanups (operator_user_id, next_attempt_at) where confirmed_at is null;
create index if not exists direct_call_cleanups_call_idx
  on public.direct_call_cleanups (direct_call_id);

-- The single busy predicate. Returns 'call' (non-terminal call row), 'cleanup' (unconfirmed
-- cleanup row) or null. Used by direct_call_begin and by the service's lookups.
create or replace function public.direct_call_operator_busy(p_user uuid)
returns text language sql stable security invoker set search_path = public as $$
  select case
    when exists (select 1 from public.direct_calls where operator_user_id = p_user and status not in ('ended', 'failed')) then 'call'
    when exists (select 1 from public.direct_call_cleanups where operator_user_id = p_user and confirmed_at is null) then 'cleanup'
    else null
  end;
$$;

create or replace function public.direct_call_active_for_operator(p_user uuid)
returns setof public.direct_calls language sql stable security invoker set search_path = public as $$
  select * from public.direct_calls
   where operator_user_id = p_user and status not in ('ended', 'failed')
   limit 1;
$$;

-- Atomic start (reservation): serialises on the operator, replays a known request id, refuses while busy,
-- else inserts the call (destination may be filled in afterwards, once prepare has run) together with the
-- browser Dial's unresolved_dial row.
-- outcome: created | duplicate_request | busy_call | busy_cleanup
create or replace function public.direct_call_begin(
  p_org uuid, p_operator uuid, p_property uuid, p_contact uuid,
  p_destination text, p_caller text, p_request uuid)
returns table (outcome text, call_id uuid) language plpgsql security invoker set search_path = public as $$
declare
  existing uuid;
  busy text;
  created uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_operator::text, 0));
  select id into existing from public.direct_calls where operator_user_id = p_operator and client_request_id = p_request;
  if existing is not null then
    return query select 'duplicate_request'::text, existing;
    return;
  end if;
  busy := public.direct_call_operator_busy(p_operator);
  if busy = 'call' then
    return query select 'busy_call'::text, null::uuid;
    return;
  elsif busy = 'cleanup' then
    return query select 'busy_cleanup'::text, null::uuid;
    return;
  end if;
  insert into public.direct_calls (org_id, operator_user_id, property_id, contact_id, destination_e164, caller_id_e164, client_request_id)
  values (p_org, p_operator, p_property, p_contact, p_destination, p_caller, p_request)
  returning id into created;
  -- The browser Dial is about to be sent: its unresolved_dial obligation exists before it is.
  insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, dial_role, resolve_after, backstop_at, next_attempt_at)
  values (p_org, p_operator, created, 'unresolved_dial', 'browser',
          now() + interval '45 seconds', now() + interval '7260 seconds', now() + interval '45 seconds');
  return query select 'created'::text, created;
end;
$$;

-- Cancel by client request id: an existing call is returned for the normal hangup path; otherwise a
-- terminal tombstone is recorded so a late start with that id dials nothing.
-- outcome: existing | tombstoned
create or replace function public.direct_call_cancel_request(p_org uuid, p_operator uuid, p_request uuid)
returns table (outcome text, call_id uuid) language plpgsql security invoker set search_path = public as $$
declare
  existing uuid;
  created uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_operator::text, 0));
  select id into existing from public.direct_calls where operator_user_id = p_operator and client_request_id = p_request;
  if existing is not null then
    return query select 'existing'::text, existing;
    return;
  end if;
  insert into public.direct_calls (org_id, operator_user_id, destination_e164, caller_id_e164, status, failure_reason, ended_at, client_request_id)
  values (p_org, p_operator, '', '', 'failed', 'cancelled_before_start', now(), p_request)
  returning id into created;
  return query select 'tombstoned'::text, created;
end;
$$;

-- Conditional update of a call (status compare-and-set) plus the cleanup rows that update obliges,
-- in one statement. p_patch keys: status, browser_leg_id, seller_leg_id, hangup_cause, failure_reason
-- (null allowed), connected_at, ended_at, seller_dial_state. p_cleanups: [{kind, leg_id?}] for a leg, or
-- [{kind:'unresolved_dial', role, timeout_secs, time_limit_secs}].
-- Under the row lock, a MOVE to ending/ended/failed (status changes) ALSO queues a leg cleanup for every leg id on the
-- CURRENT row that has no evidence of having ended (a cleanup row, or a received call.hangup event), so a
-- leg stored by a concurrent Dial response is never left alive by a caller that read a stale snapshot. Open
-- unresolved_dial rows are never touched by that move. A lead call that becomes terminal without having
-- connected sets resume_pending when no other non-terminal direct call is on the property.
-- Returns the updated row, or nothing when the status no longer matched.
create or replace function public.direct_call_apply(p_id uuid, p_statuses text[], p_patch jsonb, p_cleanups jsonb)
returns setof public.direct_calls language plpgsql security invoker set search_path = public as $$
declare
  prev public.direct_calls;
  r public.direct_calls;
begin
  select * into prev from public.direct_calls where id = p_id for update;
  if not found or not (prev.status = any(p_statuses)) then
    return;
  end if;
  update public.direct_calls set
    status = case when p_patch ? 'status' then p_patch->>'status' else status end,
    browser_leg_id = case when p_patch ? 'browser_leg_id' then p_patch->>'browser_leg_id' else browser_leg_id end,
    seller_leg_id = case when p_patch ? 'seller_leg_id' then p_patch->>'seller_leg_id' else seller_leg_id end,
    hangup_cause = case when p_patch ? 'hangup_cause' then p_patch->>'hangup_cause' else hangup_cause end,
    failure_reason = case when p_patch ? 'failure_reason' then p_patch->>'failure_reason' else failure_reason end,
    connected_at = case when p_patch ? 'connected_at' then (p_patch->>'connected_at')::timestamptz else connected_at end,
    ended_at = case when p_patch ? 'ended_at' then (p_patch->>'ended_at')::timestamptz else ended_at end,
    seller_dial_state = case when p_patch ? 'seller_dial_state' then p_patch->>'seller_dial_state' else seller_dial_state end,
    updated_at = now()
  where id = p_id
  returning * into r;
  -- A leg learned (or the seller Dial confirmed sent) resolves that Dial's unresolved obligation.
  if p_patch ? 'browser_leg_id' then
    update public.direct_call_cleanups set confirmed_at = now()
     where direct_call_id = p_id and kind = 'unresolved_dial' and dial_role = 'browser' and confirmed_at is null;
  end if;
  if p_patch ? 'seller_leg_id' or p_patch->>'seller_dial_state' = 'sent' then
    update public.direct_call_cleanups set confirmed_at = now()
     where direct_call_id = p_id and kind = 'unresolved_dial' and dial_role = 'seller' and confirmed_at is null;
  end if;
  insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, leg_id, dial_role, resolve_after, backstop_at, next_attempt_at)
  select r.org_id, r.operator_user_id, r.id, e->>'kind', e->>'leg_id', e->>'role',
         case when e->>'kind' = 'unresolved_dial' then now() + make_interval(secs => (e->>'timeout_secs')::int + 15) end,
         case when e->>'kind' = 'unresolved_dial' then now() + make_interval(secs => (e->>'time_limit_secs')::int + 60) end,
         case when e->>'kind' = 'unresolved_dial' then now() + make_interval(secs => (e->>'timeout_secs')::int + 15) else now() end
    from jsonb_array_elements(coalesce(p_cleanups, '[]'::jsonb)) e
  on conflict do nothing;
  if r.status in ('ending', 'ended', 'failed') and prev.status <> r.status then
    insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, leg_id)
    select r.org_id, r.operator_user_id, r.id, 'leg', l.leg_id
      from (values (r.browser_leg_id), (r.seller_leg_id)) as l(leg_id)
     where l.leg_id is not null
       and not exists (
         select 1 from public.direct_call_events ev
          where ev.event_type = 'call.hangup' and ev.payload->'data'->'payload'->>'call_control_id' = l.leg_id)
    on conflict do nothing;
  end if;
  if r.status in ('ended', 'failed') and prev.status not in ('ended', 'failed')
     and r.connected_at is null and r.property_id is not null
     and not exists (
       select 1 from public.direct_calls o
        where o.property_id = r.property_id and o.id <> r.id and o.status not in ('ended', 'failed')) then
    update public.direct_calls set resume_pending = true where id = r.id returning * into r;
  end if;
  return next r;
end;
$$;

-- A Dial (browser or seller) answered with a leg id. Stores it on the call when free, resolves that
-- Dial's unresolved_dial row, and queues a leg cleanup when the leg must not live (call already
-- ending/over, or the id conflicts with a different stored leg). Returns true when stored on the call.
create or replace function public.direct_call_dial_succeeded(p_id uuid, p_leg text, p_role text)
returns boolean language plpgsql security invoker set search_path = public as $$
declare
  r public.direct_calls;
  current_leg text;
  stored boolean := false;
begin
  select * into r from public.direct_calls where id = p_id for update;
  if not found then
    return false;
  end if;
  current_leg := case when p_role = 'browser' then r.browser_leg_id else r.seller_leg_id end;
  if current_leg is null then
    if p_role = 'browser' then
      update public.direct_calls set browser_leg_id = p_leg, updated_at = now() where id = p_id;
    else
      update public.direct_calls set seller_leg_id = p_leg, seller_dial_state = 'sent', updated_at = now() where id = p_id;
    end if;
    stored := true;
  elsif current_leg = p_leg then
    if p_role = 'seller' then
      update public.direct_calls set seller_dial_state = 'sent' where id = p_id and seller_dial_state = 'pending';
    end if;
    stored := true;
  end if;
  update public.direct_call_cleanups set confirmed_at = now()
   where direct_call_id = p_id and kind = 'unresolved_dial' and dial_role = p_role and confirmed_at is null;
  if not stored or r.status in ('ending', 'ended', 'failed') or r.failure_reason = 'teardown_pending' then
    insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, leg_id)
    values (r.org_id, r.operator_user_id, r.id, 'leg', p_leg)
    on conflict do nothing;
  end if;
  return stored;
end;
$$;

-- The provider definitively refused a Dial (4xx): no leg exists, nothing to reconcile.
create or replace function public.direct_call_dial_rejected(p_id uuid, p_role text)
returns void language sql security invoker set search_path = public as $$
  update public.direct_call_cleanups set confirmed_at = now()
   where direct_call_id = p_id and kind = 'unresolved_dial' and dial_role = p_role and confirmed_at is null;
$$;

-- Fills in the prepared target on a reservation that has not progressed past browser_connecting.
create or replace function public.direct_call_set_target(p_id uuid, p_property uuid, p_contact uuid, p_destination text)
returns void language sql security invoker set search_path = public as $$
  update public.direct_calls
     set property_id = p_property, contact_id = p_contact, destination_e164 = p_destination, updated_at = now()
   where id = p_id and status = 'browser_connecting';
$$;

-- Drops a reservation whose prepare was refused (no Dial was ever sent; cascades its cleanup rows).
create or replace function public.direct_call_discard_reservation(p_id uuid)
returns void language sql security invoker set search_path = public as $$
  delete from public.direct_calls
   where id = p_id and status = 'browser_connecting' and browser_leg_id is null and seller_leg_id is null;
$$;

-- Queue a leg for hangup (idempotent per leg id). No-op when the leg already has a row.
create or replace function public.direct_call_cleanup_add_leg(p_id uuid, p_leg text)
returns void language sql security invoker set search_path = public as $$
  insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, leg_id)
  select org_id, operator_user_id, id, 'leg', p_leg from public.direct_calls where id = p_id
  on conflict do nothing;
$$;

-- Claims up to p_limit due, actionable cleanup rows for an operator (unresolved dials first) by pushing
-- next_attempt_at out by a lease, so concurrent processors do not double-act. unresolved_dial rows are actionable only once the call's
-- teardown has begun (a live call's in-flight Dial is not an orphan).
create or replace function public.direct_call_cleanup_claim(p_user uuid, p_now timestamptz, p_lease_secs integer, p_limit integer)
returns setof public.direct_call_cleanups language sql security invoker set search_path = public as $$
  update public.direct_call_cleanups k
     set next_attempt_at = p_now + make_interval(secs => p_lease_secs)
   where k.id in (
     select c.id from public.direct_call_cleanups c
      where c.operator_user_id = p_user and c.confirmed_at is null and c.next_attempt_at <= p_now
        and (c.kind = 'leg' or exists (
          select 1 from public.direct_calls d
           where d.id = c.direct_call_id
             and (d.status in ('ending', 'ended', 'failed') or d.failure_reason = 'teardown_pending')))
      order by (c.kind = 'leg'), c.created_at
      limit p_limit
      for update skip locked)
  returning k.*;
$$;

-- Claims this operator's pending lead resumes with a short lease (so concurrent sessions do not both
-- resume), and marks one done once the resume function returned without throwing.
create or replace function public.direct_call_resume_claim(p_user uuid, p_now timestamptz, p_lease_secs integer)
returns setof public.direct_calls language sql security invoker set search_path = public as $$
  update public.direct_calls k
     set resume_claimed_at = p_now
   where k.id in (
     select c.id from public.direct_calls c
      where c.operator_user_id = p_user and c.resume_pending
        and (c.resume_claimed_at is null or c.resume_claimed_at <= p_now - make_interval(secs => p_lease_secs))
      order by c.ended_at
      for update skip locked)
  returning k.*;
$$;

create or replace function public.direct_call_resume_done(p_id uuid)
returns void language sql security invoker set search_path = public as $$
  update public.direct_calls set resume_pending = false, resume_claimed_at = null where id = p_id;
$$;

create table if not exists public.direct_call_events (
  provider_event_id text primary key,
  direct_call_id uuid references public.direct_calls(id) on delete set null,
  event_type text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  payload jsonb not null
);

create index if not exists direct_call_events_call_idx
  on public.direct_call_events (direct_call_id, received_at);
-- Evidence that a leg ended (read by direct_call_apply under the row lock).
create index if not exists direct_call_events_hangup_leg_idx
  on public.direct_call_events ((payload->'data'->'payload'->>'call_control_id'))
  where event_type = 'call.hangup';

alter table public.direct_call_operators enable row level security;
alter table public.direct_calls enable row level security;
alter table public.direct_call_events enable row level security;
alter table public.direct_call_cleanups enable row level security;

revoke all on public.direct_call_operators from public, anon, authenticated;
revoke all on public.direct_calls from public, anon, authenticated;
revoke all on public.direct_call_events from public, anon, authenticated;
revoke all on public.direct_call_cleanups from public, anon, authenticated;
grant select on public.direct_call_operators to authenticated;
grant select on public.direct_calls to authenticated;
grant select on public.direct_call_events to authenticated;
grant select, insert, update, delete on public.direct_call_operators to service_role;
grant select, insert, update, delete on public.direct_calls to service_role;
grant select, insert, update, delete on public.direct_call_events to service_role;
grant select, insert, update, delete on public.direct_call_cleanups to service_role;

-- Server-only functions: service_role alone.
revoke all on function public.direct_call_operator_busy(uuid) from public, anon, authenticated;
revoke all on function public.direct_call_active_for_operator(uuid) from public, anon, authenticated;
revoke all on function public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.direct_call_cancel_request(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.direct_call_apply(uuid, text[], jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.direct_call_dial_succeeded(uuid, text, text) from public, anon, authenticated;
revoke all on function public.direct_call_dial_rejected(uuid, text) from public, anon, authenticated;
revoke all on function public.direct_call_set_target(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.direct_call_discard_reservation(uuid) from public, anon, authenticated;
revoke all on function public.direct_call_cleanup_add_leg(uuid, text) from public, anon, authenticated;
revoke all on function public.direct_call_cleanup_claim(uuid, timestamptz, integer, integer) from public, anon, authenticated;
revoke all on function public.direct_call_resume_claim(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.direct_call_resume_done(uuid) from public, anon, authenticated;
grant execute on function public.direct_call_operator_busy(uuid) to service_role;
grant execute on function public.direct_call_active_for_operator(uuid) to service_role;
grant execute on function public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.direct_call_cancel_request(uuid, uuid, uuid) to service_role;
grant execute on function public.direct_call_apply(uuid, text[], jsonb, jsonb) to service_role;
grant execute on function public.direct_call_dial_succeeded(uuid, text, text) to service_role;
grant execute on function public.direct_call_dial_rejected(uuid, text) to service_role;
grant execute on function public.direct_call_set_target(uuid, uuid, uuid, text) to service_role;
grant execute on function public.direct_call_discard_reservation(uuid) to service_role;
grant execute on function public.direct_call_cleanup_add_leg(uuid, text) to service_role;
grant execute on function public.direct_call_cleanup_claim(uuid, timestamptz, integer, integer) to service_role;
grant execute on function public.direct_call_resume_claim(uuid, timestamptz, integer) to service_role;
grant execute on function public.direct_call_resume_done(uuid) to service_role;

drop policy if exists direct_call_operators_own_select on public.direct_call_operators;
create policy direct_call_operators_own_select on public.direct_call_operators
  for select to authenticated
  using (
    user_id = auth.uid()
    and exists (select 1 from public.memberships m
      where m.user_id = auth.uid() and m.org_id = direct_call_operators.org_id
        and m.access_status = 'active' and m.deletion_prepared_at is null)
  );

drop policy if exists direct_calls_own_select on public.direct_calls;
create policy direct_calls_own_select on public.direct_calls
  for select to authenticated
  using (
    operator_user_id = auth.uid()
    and exists (select 1 from public.memberships m
      where m.user_id = auth.uid() and m.org_id = direct_calls.org_id
        and m.access_status = 'active' and m.deletion_prepared_at is null)
  );

drop policy if exists direct_call_events_own_select on public.direct_call_events;
create policy direct_call_events_own_select on public.direct_call_events
  for select to authenticated
  using (
    exists (select 1 from public.direct_calls c
      where c.id = direct_call_events.direct_call_id and c.operator_user_id = auth.uid()
        and exists (select 1 from public.memberships m
          where m.user_id = auth.uid() and m.org_id = c.org_id
            and m.access_status = 'active' and m.deletion_prepared_at is null))
  );

commit;
