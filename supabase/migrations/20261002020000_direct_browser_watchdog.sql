-- Direct browser-loss watchdog, sequenced after the direct-call duration and preparation
-- migrations. This is additive but changes direct_call_begin's signature; apply only while the
-- direct-call feature is disabled/drained and with the matching app release. A rollback restores
-- neither the historical begin signature nor a safe old/new coexistence window.

begin;

alter table public.direct_calls
  add column if not exists browser_watchdog_session_id uuid,
  add column if not exists browser_watchdog_seen_at timestamptz,
  add column if not exists browser_watchdog_expires_at timestamptz,
  add column if not exists browser_watchdog_claimed_at timestamptz;

create table if not exists public.direct_watchdog_liveness (
  instance_id text primary key,
  seen_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists direct_calls_watchdog_expiry_idx
  on public.direct_calls (browser_watchdog_expires_at)
  where browser_watchdog_expires_at is not null and status not in ('ended', 'failed');

-- The reservation is refused before insertion when the independent monitor has not written a
-- fresh DB-clock heartbeat. Preparation owns an unarmed session; the 20-second lease is armed
-- only after target/credential work and immediately before dispatch, then renewed only by an
-- authenticated, exact-call browser presence session.
drop function if exists public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer, uuid);
drop function if exists public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer, uuid, uuid);
create or replace function public.direct_call_begin(
  p_org uuid, p_operator uuid, p_property uuid, p_contact uuid,
  p_destination text, p_caller text, p_request uuid, p_time_limit_secs integer,
  p_preparation_property uuid, p_watchdog_session uuid)
returns table(outcome text, call_id uuid)
language plpgsql security invoker set search_path = public as $$
declare
  existing uuid;
  busy text;
  created uuid;
begin
  if p_time_limit_secs is null or p_time_limit_secs < 30 or p_time_limit_secs > 7200 then
    raise exception 'invalid direct call time limit';
  end if;
  if p_property is not null and p_preparation_property is not null and p_property <> p_preparation_property then
    raise exception 'direct call preparation property mismatch';
  end if;
  if p_watchdog_session is null then
    return query select 'watchdog_unavailable'::text, null::uuid;
    return;
  end if;
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
  if not exists (
    select 1 from public.direct_watchdog_liveness
     where seen_at >= now() - interval '6 seconds'
  ) then
    return query select 'watchdog_unavailable'::text, null::uuid;
    return;
  end if;
  insert into public.direct_calls (
    org_id, operator_user_id, property_id, preparation_property_id, contact_id,
    destination_e164, caller_id_e164, time_limit_secs, client_request_id,
    browser_watchdog_session_id, browser_watchdog_seen_at, browser_watchdog_expires_at)
  values (
    p_org, p_operator, p_property, p_preparation_property, p_contact,
    p_destination, p_caller, p_time_limit_secs, p_request,
    p_watchdog_session, null, null)
  returning id into created;
  insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, dial_role, next_attempt_at)
  values (p_org, p_operator, created, 'unresolved_dial', 'browser', now());
  return query select 'created'::text, created;
end;
$$;

create or replace function public.direct_watchdog_heartbeat(p_instance text)
returns timestamptz language plpgsql security invoker set search_path = public as $$
declare
  at timestamptz := now();
begin
  if p_instance is null or length(trim(p_instance)) < 8 or length(p_instance) > 200 then
    raise exception 'invalid watchdog instance';
  end if;
  insert into public.direct_watchdog_liveness(instance_id, seen_at, updated_at)
  values (p_instance, at, at)
  on conflict (instance_id) do update set seen_at = excluded.seen_at, updated_at = excluded.updated_at;
  return at;
end;
$$;

create or replace function public.direct_call_watchdog_attach(
  p_id uuid, p_operator uuid, p_browser_leg text, p_session uuid)
returns boolean language plpgsql security invoker set search_path = public as $$
declare changed integer;
begin
  update public.direct_calls
     set browser_watchdog_seen_at = now(),
         browser_watchdog_expires_at = now() + interval '12 seconds',
         updated_at = now()
   where id = p_id and operator_user_id = p_operator and browser_leg_id = p_browser_leg
     and browser_watchdog_session_id = p_session and browser_watchdog_claimed_at is null
     and browser_watchdog_expires_at > now()
     and status in ('browser_connecting', 'seller_dialing', 'connected');
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

-- Preparation may legitimately take longer than the browser-loss lease. Arm only after the
-- prepared target and credentials are durable, immediately before the provider Dial boundary.
create or replace function public.direct_call_watchdog_arm(
  p_id uuid, p_operator uuid, p_session uuid)
returns boolean language plpgsql security invoker set search_path = public as $$
declare changed integer;
begin
  if not exists (select 1 from public.direct_watchdog_liveness where seen_at >= now() - interval '6 seconds') then
    return false;
  end if;
  update public.direct_calls
     set browser_watchdog_seen_at = now(),
         browser_watchdog_expires_at = now() + interval '20 seconds',
         updated_at = now()
   where id = p_id and operator_user_id = p_operator and browser_watchdog_session_id = p_session
     and browser_watchdog_claimed_at is null and browser_watchdog_expires_at is null
     and status = 'browser_connecting';
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function public.direct_call_watchdog_renew(
  p_id uuid, p_operator uuid, p_browser_leg text, p_session uuid)
returns boolean language plpgsql security invoker set search_path = public as $$
declare changed integer;
begin
  update public.direct_calls
     set browser_watchdog_seen_at = now(),
         browser_watchdog_expires_at = now() + interval '12 seconds',
         updated_at = now()
   where id = p_id and operator_user_id = p_operator and browser_leg_id = p_browser_leg
     and browser_watchdog_session_id = p_session and browser_watchdog_claimed_at is null
     and browser_watchdog_expires_at > now()
     and status in ('browser_connecting', 'seller_dialing', 'connected');
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

-- An abnormal browser socket gets a five-second grace for a reconnect. Server shutdown and
-- explicit graceful close leave the durable lease alone; the normal status/cleanup path owns them.
create or replace function public.direct_call_watchdog_disconnect(
  p_id uuid, p_operator uuid, p_browser_leg text, p_session uuid, p_abnormal boolean)
returns boolean language plpgsql security invoker set search_path = public as $$
declare changed integer;
begin
  update public.direct_calls
     set browser_watchdog_expires_at = case when p_abnormal
       then least(coalesce(browser_watchdog_expires_at, now() + interval '5 seconds'), now() + interval '5 seconds')
       else browser_watchdog_expires_at end,
         updated_at = now()
   where id = p_id and operator_user_id = p_operator and browser_leg_id = p_browser_leg
     and browser_watchdog_session_id = p_session and browser_watchdog_claimed_at is null
     and status in ('browser_connecting', 'seller_dialing', 'connected');
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

-- Claims are short durable leases. If the cleanup callback is unavailable, a restarted watchdog
-- can claim the row again after thirty seconds; no live call is marked ended without the app's
-- existing cleanup core confirming provider leg work.
drop function if exists public.direct_call_watchdog_claim_expired(integer);
create or replace function public.direct_call_watchdog_claim_expired(p_limit integer)
returns table(call_id uuid, operator_user_id uuid, browser_watchdog_session_id uuid)
language plpgsql security invoker set search_path = public as $$
declare r public.direct_calls;
begin
  if p_limit is null or p_limit < 1 or p_limit > 20 then return; end if;
  for r in
    select * from public.direct_calls c
     where c.browser_watchdog_expires_at <= now()
       and c.status in ('browser_connecting', 'seller_dialing', 'connected')
       and c.browser_watchdog_session_id is not null
       and (c.browser_watchdog_claimed_at is null or c.browser_watchdog_claimed_at <= now() - interval '30 seconds')
     order by c.browser_watchdog_expires_at
     limit p_limit
     for update skip locked
  loop
    update public.direct_calls
       set browser_watchdog_claimed_at = now(),
           browser_watchdog_expires_at = now() + interval '30 seconds',
           updated_at = now()
     where id = r.id;
    call_id := r.id;
    operator_user_id := r.operator_user_id;
    browser_watchdog_session_id := r.browser_watchdog_session_id;
    return next;
  end loop;
end;
$$;

revoke all on public.direct_watchdog_liveness from public, anon, authenticated;
grant select, insert, update, delete on public.direct_watchdog_liveness to service_role;
revoke all on function public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer, uuid, uuid) from public, anon, authenticated;
revoke all on function public.direct_watchdog_heartbeat(text) from public, anon, authenticated;
revoke all on function public.direct_call_watchdog_attach(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.direct_call_watchdog_arm(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.direct_call_watchdog_renew(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.direct_call_watchdog_disconnect(uuid, uuid, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.direct_call_watchdog_claim_expired(integer) from public, anon, authenticated;
grant execute on function public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer, uuid, uuid) to service_role;
grant execute on function public.direct_watchdog_heartbeat(text) to service_role;
grant execute on function public.direct_call_watchdog_attach(uuid, uuid, text, uuid) to service_role;
grant execute on function public.direct_call_watchdog_arm(uuid, uuid, uuid) to service_role;
grant execute on function public.direct_call_watchdog_renew(uuid, uuid, text, uuid) to service_role;
grant execute on function public.direct_call_watchdog_disconnect(uuid, uuid, text, uuid, boolean) to service_role;
grant execute on function public.direct_call_watchdog_claim_expired(integer) to service_role;

commit;
