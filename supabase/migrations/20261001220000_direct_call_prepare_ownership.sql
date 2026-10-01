-- Preparation ownership follow-up for 20261001210000_direct_call_duration_dispatch.sql.
-- Before any remote apply, reconcile migration history and verify direct calling is disabled/drained.
-- This additive migration is not a standalone old/new compatibility window: its rollback is used
-- immediately before the duration migration and whole-feature rollback, not as baseline restoration.

begin;

alter table public.direct_calls
  add column if not exists preparation_property_id uuid references public.properties(id) on delete set null;

-- The preparation owner is captured before prepareLeadCall can pause enrollments. The historical
-- 8-argument begin signature is intentionally replaced; old app code and this schema do not coexist.
drop function if exists public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer);
create or replace function public.direct_call_begin(
  p_org uuid, p_operator uuid, p_property uuid, p_contact uuid,
  p_destination text, p_caller text, p_request uuid, p_time_limit_secs integer,
  p_preparation_property uuid)
returns table(outcome text, call_id uuid) language plpgsql security invoker set search_path = public as $$
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
  insert into public.direct_calls (
    org_id, operator_user_id, property_id, preparation_property_id, contact_id,
    destination_e164, caller_id_e164, time_limit_secs, client_request_id)
  values (
    p_org, p_operator, p_property, p_preparation_property, p_contact,
    p_destination, p_caller, p_time_limit_secs, p_request)
  returning id into created;
  insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, dial_role, next_attempt_at)
  values (p_org, p_operator, created, 'unresolved_dial', 'browser', now());
  return query select 'created'::text, created;
end;
$$;

-- Rebuild the duration-era transition with preparation ownership included in the property lock.
-- A newer browser_connecting reservation has property_id null until prepare returns, so its
-- preparation_property_id must prevent an older late resume from reopening enrollments underneath it.
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
  insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, leg_id, dial_role, next_attempt_at)
  select r.org_id, r.operator_user_id, r.id, e->>'kind', e->>'leg_id', e->>'role', now()
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
        where coalesce(o.property_id, o.preparation_property_id) = r.property_id
          and o.id <> r.id and o.status not in ('ended', 'failed')) then
    update public.direct_calls set resume_pending = true where id = r.id returning * into r;
  end if;
  return next r;
end;
$$;

-- A late prepare result can fill only the untouched reservation it owns. The boolean return lets the
-- service fail closed before provider dispatch if cancellation or a conflicting target won the race.
drop function if exists public.direct_call_set_target(uuid, uuid, uuid, text);
create or replace function public.direct_call_set_target(p_id uuid, p_property uuid, p_contact uuid, p_destination text)
returns boolean language plpgsql security invoker set search_path = public as $$
declare
  changed integer;
begin
  update public.direct_calls
     set property_id = p_property,
         contact_id = p_contact,
         destination_e164 = p_destination,
         preparation_property_id = null,
         resume_pending = case
           when status in ('ended', 'failed') and p_property is not null and connected_at is null then true
           when p_property is null then false
           else resume_pending
         end,
         updated_at = now()
   where id = p_id
     and (
       (
         status = 'browser_connecting'
         and (preparation_property_id is null or p_property is null or p_property = preparation_property_id)
       )
       or (
         status in ('ending', 'ended', 'failed')
         and (preparation_property_id is not null or p_property is null)
         and (p_property is null or p_property = preparation_property_id)
         and property_id is null
         and contact_id is null
         and destination_e164 = ''
         and browser_leg_id is null
         and seller_leg_id is null
         and connected_at is null
       )
     );
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

-- Do not work a lead resume while its prepare call still owns the property but has not supplied the
-- target. The late set_target write clears preparation_property_id before this claim can proceed.
create or replace function public.direct_call_resume_claim(p_user uuid, p_now timestamptz, p_lease_secs integer)
returns setof public.direct_calls language sql security invoker set search_path = public as $$
  update public.direct_calls k
     set resume_claimed_at = p_now
   where k.id in (
     select c.id from public.direct_calls c
      where c.operator_user_id = p_user and c.resume_pending
        and c.preparation_property_id is null
        and c.property_id is not null
        and c.destination_e164 <> ''
        and (c.resume_claimed_at is null or c.resume_claimed_at <= p_now - make_interval(secs => p_lease_secs))
      order by c.ended_at
      for update skip locked)
  returning k.*;
$$;

revoke all on function public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.direct_call_set_target(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.direct_call_resume_claim(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer, uuid) to service_role;
grant execute on function public.direct_call_set_target(uuid, uuid, uuid, text) to service_role;
grant execute on function public.direct_call_resume_claim(uuid, timestamptz, integer) to service_role;

commit;
