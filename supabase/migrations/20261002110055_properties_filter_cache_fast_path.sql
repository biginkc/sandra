-- Fast path for the filter-cache message/task INSERT triggers (follows 20261002110000/110050).
--
-- Why: every inbound message used to take a FOR NO KEY UPDATE row lock on its property and
-- recompute 7 lookups, serialising same-property bursts (see INBOX-BURST-EVIDENCE.md).
-- Now an INSERT whose rows are already covered by the cached flags (inbound with has_inbound_message
-- true and read or has_unread_inbound true; outbound with has_outbound_message true; a non-open task;
-- an open task with has_open_tasks true; a row whose org differs from the property's) skips the
-- refresh. Everything else, and every UPDATE/DELETE, keeps the full refresh unchanged.
--
-- Correctness (no lost update): a skip is only taken while holding a SHARED row lock on the property
-- (SELECT ... FOR SHARE) acquired after the shared global-DNC barrier, and the coverage check is
-- re-evaluated AFTER the lock under a fresh snapshot. A clearing writer (delete / read / move /
-- direction change / task close) refreshes with FOR NO KEY UPDATE, which conflicts with FOR SHARE, so
-- it cannot clear a flag between our check and our commit; it waits, then recomputes with our row
-- visible. If a clear had already committed, the re-check fails and we run the full refresh.
-- Shared lockers do not block each other, so same-property insert bursts no longer serialise. A skipped
-- insert that finds its flag newly cleared upgrades share -> no-key-update, which can in theory
-- deadlock with another upgrader on the same property (retryable 40P01; vanishingly rare).
-- Additive create-or-replace only; the trigger definitions themselves are unchanged.

set lock_timeout = '5s';

begin;

create or replace function public.trg_messages_refresh_filter_cache()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Fast path: a property whose cached flags already cover every new row cannot change.
    -- 1) unlocked read: refresh immediately the properties that are NOT covered.
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
    perform public.refresh_property_filter_cache(array(
      select distinct n.property_id from new_rows n
        join public.properties p on p.id = n.property_id
       where n.property_id is not null and n.org_id = p.org_id
         and not (case n.direction
                    when 'inbound'  then p.has_inbound_message and (n.read_at is not null or p.has_unread_inbound)
                    when 'outbound' then p.has_outbound_message
                    else false end)));
    -- 2) the rest LOOK covered. Take a SHARED row lock (conflicts with a clearing refresh's
    --    NO KEY UPDATE, not with other inserters) so no concurrent tx can clear a flag until
    --    we commit, then re-check under a fresh snapshot; anything no longer covered (a clear
    --    committed in between) gets the full refresh.
    perform 1 from public.properties p
     where p.id in (select n.property_id from new_rows n where n.property_id is not null and n.org_id = p.org_id)
     order by p.id for share;
    perform public.refresh_property_filter_cache(array(
      select distinct n.property_id from new_rows n
        join public.properties p on p.id = n.property_id
       where n.property_id is not null and n.org_id = p.org_id
         and not (case n.direction
                    when 'inbound'  then p.has_inbound_message and (n.read_at is not null or p.has_unread_inbound)
                    when 'outbound' then p.has_outbound_message
                    else false end)));
  elsif tg_op = 'DELETE' then
    perform public.refresh_property_filter_cache(array(select distinct o.property_id from old_rows o where o.property_id is not null));
  else
    perform public.refresh_property_filter_cache(array(
      select x.property_id from (
        select property_id, org_id, direction, read_at from old_rows except all select property_id, org_id, direction, read_at from new_rows
      ) x where x.property_id is not null
      union
      select y.property_id from (
        select property_id, org_id, direction, read_at from new_rows except all select property_id, org_id, direction, read_at from old_rows
      ) y where y.property_id is not null));
  end if;
  return null;
end;
$$;

create or replace function public.trg_tasks_refresh_filter_cache()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Fast path (same protocol as messages). Only an OPEN task can change the cache, and only if
    -- has_open_tasks is not already true.
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
    perform public.refresh_property_filter_cache(array(
      select distinct n.related_property_id from new_rows n
        join public.properties p on p.id = n.related_property_id
       where n.status = 'open' and n.org_id = p.org_id and not p.has_open_tasks));
    perform 1 from public.properties p
     where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id)
     order by p.id for share;
    perform public.refresh_property_filter_cache(array(
      select distinct n.related_property_id from new_rows n
        join public.properties p on p.id = n.related_property_id
       where n.status = 'open' and n.org_id = p.org_id and not p.has_open_tasks));
  elsif tg_op = 'DELETE' then
    perform public.refresh_property_filter_cache(array(select distinct o.related_property_id from old_rows o));
  else
    perform public.refresh_property_filter_cache(array(
      select x.related_property_id from (
        select related_property_id, org_id, status from old_rows except all select related_property_id, org_id, status from new_rows
      ) x where x.related_property_id is not null
      union
      select y.related_property_id from (
        select related_property_id, org_id, status from new_rows except all select related_property_id, org_id, status from old_rows
      ) y where y.related_property_id is not null));
  end if;
  return null;
end;
$$;

commit;

notify pgrst, 'reload schema';
