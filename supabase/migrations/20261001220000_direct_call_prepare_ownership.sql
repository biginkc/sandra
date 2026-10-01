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
