-- Duration and dispatch timing migration. This local file is sequenced after
-- 20261001200000_direct_calls.sql. Before any remote apply, run the migration-history preflight
-- and reconcile the remote history against this exact sequence; local placement is not remote
-- deployment authorization or proof that the remote schema is safe to change.
-- The new 8-argument direct_call_begin replaces the historical 7-argument signature; old app code
-- and this migration are not a supported coexistence window. Release ordering must verify disabled/
-- drained direct calling plus a coordinated app+schema rollout. Keep this gate even after local
-- loopback migration and rollback tests pass.
--
-- The reservation still owns the operator lock, but provider timing begins at the durable dispatch
-- marker immediately before each Dial. The limit is frozen on the call row so later environment edits
-- cannot widen an in-flight call. Unknown-Dial backstops include ring timeout + active leg limit + 60s
-- grace because Telnyx's time_limit_secs applies to the leg after answer. A named 10-second marker
-- response allowance is included in all provider-facing cleanup clocks; callers refuse to Dial after it.

begin;

alter table public.direct_calls
  add column if not exists time_limit_secs integer;
update public.direct_calls set time_limit_secs = 7200 where time_limit_secs is null;
alter table public.direct_calls alter column time_limit_secs set default 7200;
alter table public.direct_calls alter column time_limit_secs set not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'direct_calls_time_limit_secs_check'
       and conrelid = 'public.direct_calls'::regclass
  ) then
    alter table public.direct_calls add constraint direct_calls_time_limit_secs_check check (time_limit_secs between 30 and 7200);
  end if;
end;
$$;
alter table public.direct_calls add column if not exists browser_dial_started_at timestamptz;

alter table public.direct_call_cleanups add column if not exists dial_started_at timestamptz;
-- Rows created by the historical migration already have reservation-time bounds. Preserve them as
-- already-dispatched legacy obligations; all new unresolved rows remain unanchored until the marker.
update public.direct_call_cleanups
   set dial_started_at = created_at
 where kind = 'unresolved_dial' and dial_started_at is null and (resolve_after is not null or backstop_at is not null);

drop function if exists public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid);
create or replace function public.direct_call_begin(
  p_org uuid, p_operator uuid, p_property uuid, p_contact uuid,
  p_destination text, p_caller text, p_request uuid, p_time_limit_secs integer)
returns table(outcome text, call_id uuid) language plpgsql security invoker set search_path = public as $$
declare
  existing uuid;
  busy text;
  created uuid;
begin
  if p_time_limit_secs is null or p_time_limit_secs < 30 or p_time_limit_secs > 7200 then
    raise exception 'invalid direct call time limit';
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
  insert into public.direct_calls (org_id, operator_user_id, property_id, contact_id, destination_e164, caller_id_e164, time_limit_secs, client_request_id)
  values (p_org, p_operator, p_property, p_contact, p_destination, p_caller, p_time_limit_secs, p_request)
  returning id into created;
  -- The browser Dial obligation exists before the request. Its timing is filled by direct_call_dial_started.
  insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, dial_role, next_attempt_at)
  values (p_org, p_operator, created, 'unresolved_dial', 'browser', now());
  return query select 'created'::text, created;
end;
$$;

-- New unresolved Dial rows are intentionally unanchored. A provider request is never considered
-- dispatched until this function succeeds under the call row lock.
create or replace function public.direct_call_dial_started(
  p_id uuid, p_role text, p_started_at timestamptz, p_timeout_secs integer, p_time_limit_secs integer)
returns boolean language plpgsql security invoker set search_path = public as $$
declare
  r public.direct_calls;
  changed integer;
  dispatch_allowance constant integer := 10;
begin
  if p_role not in ('browser', 'seller') or p_started_at is null or p_timeout_secs is null or p_timeout_secs < 0
     or p_time_limit_secs is null or p_time_limit_secs < 30 then
    return false;
  end if;
  select * into r from public.direct_calls where id = p_id for update;
  if not found then return false; end if;
  if r.failure_reason = 'teardown_pending'
     or (p_role = 'browser' and r.status <> 'browser_connecting')
     or (p_role = 'seller' and (r.status <> 'seller_dialing' or r.seller_dial_state is distinct from 'pending')) then
    return false;
  end if;
  if p_time_limit_secs > r.time_limit_secs then return false; end if;
  update public.direct_call_cleanups
     set dial_started_at = p_started_at,
         -- Allow the marker response to return before beginning the provider-facing timeout clocks.
         resolve_after = p_started_at + make_interval(secs => p_timeout_secs + dispatch_allowance + 15),
         -- time_limit_secs is the active leg window after answer; include ring timeout and grace.
         backstop_at = p_started_at + make_interval(secs => p_timeout_secs + dispatch_allowance + p_time_limit_secs + 60),
         next_attempt_at = p_started_at + make_interval(secs => p_timeout_secs + dispatch_allowance + 15)
   where direct_call_id = p_id and kind = 'unresolved_dial' and dial_role = p_role
     and confirmed_at is null and dial_started_at is null;
  get diagnostics changed = row_count;
  if changed <> 1 then return false; end if;
  if p_role = 'browser' then
    update public.direct_calls set browser_dial_started_at = p_started_at, updated_at = now() where id = p_id;
  end if;
  return true;
end;
$$;

-- Rebuild the apply function only to defer unresolved-Dial timing until the dispatch marker. The
-- existing transition, cleanup, lead-resume, and row-lock behavior remains unchanged.
create or replace function public.direct_call_apply(p_id uuid, p_statuses text[], p_patch jsonb, p_cleanups jsonb)
returns setof public.direct_calls language plpgsql security invoker set search_path = public as $$
declare
  prev public.direct_calls;
  r public.direct_calls;
begin
  select * into prev from public.direct_calls where id = p_id for update;
  if not found or not (prev.status = any(p_statuses)) then return; end if;
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
  where id = p_id returning * into r;
  if p_patch ? 'browser_leg_id' then
    update public.direct_call_cleanups set confirmed_at = now()
     where direct_call_id = p_id and kind = 'unresolved_dial' and dial_role = 'browser' and confirmed_at is null;
  end if;
  if p_patch ? 'seller_leg_id' or p_patch->>'seller_dial_state' = 'sent' then
    update public.direct_call_cleanups set confirmed_at = now()
     where direct_call_id = p_id and kind = 'unresolved_dial' and dial_role = 'seller' and confirmed_at is null;
  end if;
  -- Keep one insert, as in the historical function, so cleanup kind/role constraints
  -- still reject malformed service-role input. Only unresolved-Dial timing is deferred.
  insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, leg_id, dial_role, next_attempt_at)
  select r.org_id, r.operator_user_id, r.id, e->>'kind', e->>'leg_id', e->>'role',
         now()
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

revoke all on function public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.direct_call_dial_started(uuid, text, timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer) to service_role;
grant execute on function public.direct_call_dial_started(uuid, text, timestamptz, integer, integer) to service_role;

commit;
