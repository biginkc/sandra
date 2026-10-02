-- Incremental insert path for the filter-cache triggers (follows 20261002110000/110050).
--
-- Why: every inbound message used to take a FOR NO KEY UPDATE row lock on its property and run the full
-- 7-lookup recompute (see INBOX-BURST-EVIDENCE.md). INSERTs can only SET flags / ADD ids, so they now apply
-- an incremental, guarded UPDATE instead; changes that can CLEAR a flag (deletes, read_at / direction /
-- property / org / status changes, list/tag removal) keep the full refresh unchanged.
--
-- messages INSERT: has_inbound_message / has_outbound_message / has_unread_inbound |= what the new rows imply
-- (rows of another org never count). tasks INSERT: has_open_tasks = true for an open task (a non-open task changes
-- nothing). property_lists / property_tags INSERT: sorted-deduplicated id merge + count, identical to the full refresh
-- (unique (property_id, list_id|tag_id) guarantees equivalence).
--
-- Correctness (no lost update): order is shared global-DNC barrier -> row locks. (a) the guarded UPDATE locks and
-- changes exactly the rows whose flags are not yet covered, re-evaluating the guard on the locked latest row version;
-- (b) rows that LOOK covered take a SHARED row lock (conflicts with a clearing refresh's NO KEY UPDATE, not with other
-- inserters), so no clearer can run between our check and our commit; a clearer then recomputes with our row visible;
-- (c) the same guarded UPDATE is re-applied under a fresh snapshot for anything a committed clear uncovered meanwhile.
-- List/tag merges are unguarded (always row-locking). A (c) upgrade from share to no-key-update can theoretically
-- deadlock with another upgrader on the same property (retryable 40P01).
-- Additive create-or-replace only; trigger definitions themselves are unchanged.

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
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
    -- a) incremental, monotonic (OR-only) set of the flags the new rows imply; the guarded UPDATE row-locks
    --    (FOR NO KEY UPDATE) exactly the properties that need a change.
    update public.properties p
       set has_inbound_message  = p.has_inbound_message  or a.hi,
           has_outbound_message = p.has_outbound_message or a.ho,
           has_unread_inbound   = p.has_unread_inbound   or a.hu
      from (select n.property_id as id, n.org_id,
                   pg_catalog.bool_or(n.direction = 'inbound') as hi,
                   pg_catalog.bool_or(n.direction = 'outbound') as ho,
                   pg_catalog.bool_or(n.direction = 'inbound' and n.read_at is null) as hu
              from new_rows n where n.property_id is not null group by n.property_id, n.org_id) a
     where p.id = a.id and p.org_id = a.org_id
       and ((a.hi and not p.has_inbound_message) or (a.ho and not p.has_outbound_message) or (a.hu and not p.has_unread_inbound));
    -- b) properties already covered take a SHARED lock so no concurrent clearer can slip in,
    -- c) then re-apply under a fresh snapshot for anything a committed clear uncovered meanwhile.
    perform 1 from public.properties p
     where p.id in (select n.property_id from new_rows n where n.property_id is not null and n.org_id = p.org_id)
     order by p.id for share;
    update public.properties p
       set has_inbound_message  = p.has_inbound_message  or a.hi,
           has_outbound_message = p.has_outbound_message or a.ho,
           has_unread_inbound   = p.has_unread_inbound   or a.hu
      from (select n.property_id as id, n.org_id,
                   pg_catalog.bool_or(n.direction = 'inbound') as hi,
                   pg_catalog.bool_or(n.direction = 'outbound') as ho,
                   pg_catalog.bool_or(n.direction = 'inbound' and n.read_at is null) as hu
              from new_rows n where n.property_id is not null group by n.property_id, n.org_id) a
     where p.id = a.id and p.org_id = a.org_id
       and ((a.hi and not p.has_inbound_message) or (a.ho and not p.has_outbound_message) or (a.hu and not p.has_unread_inbound));
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'off', true);
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
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
    update public.properties p set has_open_tasks = true
     where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id)
       and not p.has_open_tasks;
    perform 1 from public.properties p
     where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id)
     order by p.id for share;
    update public.properties p set has_open_tasks = true
     where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id)
       and not p.has_open_tasks;
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'off', true);
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

create or replace function public.trg_property_lists_refresh_filter_cache()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
    -- Unconditional (rare) incremental merge: unique (property_id, list_id) means ids never repeat; the merge is
    -- deduplicated and sorted exactly like the full refresh, and the UPDATE row-locks the property.
    update public.properties p
       set filter_list_ids = (select coalesce(pg_catalog.array_agg(distinct x order by x), '{}'::uuid[]) from unnest(p.filter_list_ids || a.ids) x),
           filter_list_count = (select pg_catalog.count(distinct x) from unnest(p.filter_list_ids || a.ids) x)::integer
      from (select n.property_id as id, n.org_id, pg_catalog.array_agg(n.list_id) as ids
              from new_rows n group by n.property_id, n.org_id) a
     where p.id = a.id and p.org_id = a.org_id;
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'off', true);
  elsif tg_op = 'DELETE' then
    perform public.refresh_property_filter_cache(array(select distinct o.property_id from old_rows o));
  else
    perform public.refresh_property_filter_cache(array(
      select x.property_id from (
        select property_id, org_id, list_id from old_rows except all select property_id, org_id, list_id from new_rows
      ) x where x.property_id is not null
      union
      select y.property_id from (
        select property_id, org_id, list_id from new_rows except all select property_id, org_id, list_id from old_rows
      ) y where y.property_id is not null));
  end if;
  return null;
end;
$$;

create or replace function public.trg_property_tags_refresh_filter_cache()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
    -- Unconditional (rare) incremental merge: unique (property_id, tag_id) means ids never repeat; the merge is
    -- deduplicated and sorted exactly like the full refresh, and the UPDATE row-locks the property.
    update public.properties p
       set filter_tag_ids = (select coalesce(pg_catalog.array_agg(distinct x order by x), '{}'::uuid[]) from unnest(p.filter_tag_ids || a.ids) x)
      from (select n.property_id as id, n.org_id, pg_catalog.array_agg(n.tag_id) as ids
              from new_rows n group by n.property_id, n.org_id) a
     where p.id = a.id and p.org_id = a.org_id;
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'off', true);
  elsif tg_op = 'DELETE' then
    perform public.refresh_property_filter_cache(array(select distinct o.property_id from old_rows o));
  else
    perform public.refresh_property_filter_cache(array(
      select x.property_id from (
        select property_id, org_id, tag_id from old_rows except all select property_id, org_id, tag_id from new_rows
      ) x where x.property_id is not null
      union
      select y.property_id from (
        select property_id, org_id, tag_id from new_rows except all select property_id, org_id, tag_id from old_rows
      ) y where y.property_id is not null));
  end if;
  return null;
end;
$$;

commit;

notify pgrst, 'reload schema';
