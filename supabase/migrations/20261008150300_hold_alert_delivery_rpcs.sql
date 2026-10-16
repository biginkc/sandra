-- 20261008150300_hold_alert_delivery_rpcs.sql
-- Messages v2 Phase 1 review round 4 follow-ups. Patches forward from 20261008150200.
--
-- 1. hold_alert_latest_status: the newest live delivery row per property
--    (distinct on property_id), so one noisy property can never push another
--    property's status out of a shared row cap. SECURITY INVOKER: RLS on
--    hold_alert_deliveries applies to the caller.
-- 2. hold_alert_archive_rows: archive a page of closed delivery rows with ONE
--    update ... where id = any(...) instead of one update per row. Guarded on
--    "not already archived" so a concurrent pass matches nothing. Returns the
--    number archived. Service role only.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.hold_alert_latest_status(
  p_org_id uuid,
  p_property_ids uuid[]
)
returns table (property_id uuid, status text, last_error text, created_at timestamptz)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select distinct on (d.property_id) d.property_id, d.status, d.last_error, d.created_at
  from public.hold_alert_deliveries d
  where d.org_id = p_org_id
    and d.property_id = any(p_property_ids)
    and d.hold_key not like '%:closed:%'
  order by d.property_id, d.created_at desc, d.id desc;
$$;

revoke all on function public.hold_alert_latest_status(uuid, uuid[]) from public, anon;
grant execute on function public.hold_alert_latest_status(uuid, uuid[]) to authenticated, service_role;

create or replace function public.hold_alert_archive_rows(
  p_org_id uuid,
  p_ids uuid[]
)
returns integer
language sql
security invoker
set search_path = public, pg_temp
as $$
  with archived as (
    update public.hold_alert_deliveries d
       set hold_key = d.hold_key || ':closed:' || d.id::text
     where d.org_id = p_org_id
       and d.id = any(p_ids)
       and d.property_id is not null
       and d.hold_key not like '%:closed:%'
    returning d.id
  )
  select count(*)::integer from archived;
$$;

revoke all on function public.hold_alert_archive_rows(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.hold_alert_archive_rows(uuid, uuid[]) to service_role;

commit;
