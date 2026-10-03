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
-- Variant E additionally: HOT-eligible flips (drop boolean partial indexes, fillfactor 90), a cheaper cache-only comparator,
-- id-ordered row locks before incremental updates (a multi-property statement locks its WHOLE affected set in one id order and
-- skips the share/skip phase; the share-skip fast path is single-property only), and the writer GUC is restored to its prior value (not forced off).
-- Additive create-or-replace plus the index drops; trigger definitions themselves are unchanged.

-- Notes (comparator / rollback):
--  * properties_filter_cache_only_change fast path compares composite rows with IS NOT DISTINCT FROM semantics
--    (e.g. numeric 10 equals 10.0). Unreachable here: the compared columns are copies of one another except the cache
--    columns. NOTE: a composite comparison raises for column types without an equality operator (json, xml, point...), so
--    a future column of such a type makes this function error until it is handled; the regression test
--    "a generated column added later ..." (filter-cache-triggers.integration.test.ts) and a type-without-equality
--    column would surface it immediately.
--  * Rollback of the index drops: recreate the four partial indexes exactly as in 20261002110000 (lines ~479-482):
--      create index idx_properties_has_unread_inbound on public.properties (org_id) where has_unread_inbound;
--      create index idx_properties_has_open_tasks on public.properties (org_id) where has_open_tasks;
--      create index idx_properties_has_inbound_message on public.properties (org_id) where has_inbound_message;
--      create index idx_properties_attempted on public.properties (org_id) where has_outbound_message and not has_inbound_message;
--    and `alter table public.properties reset (fillfactor)`. The trigger changes roll back by re-applying the 20261002110000 bodies.

set lock_timeout = '5s';

begin;

-- HOT-friendly flag flips: the partial indexes whose predicates use the four boolean cache columns force every
-- flip to write into every index on public.properties (non-HOT). Dropping them lets a flag flip be a HOT update;
-- fillfactor 90 leaves page room (applies to new pages only). The GIN indexes on the id arrays stay (list/tag
-- changes are rare). Filter queries on the booleans scan with a Filter (see the volume gate).
lock table public.properties in access exclusive mode;
drop index if exists public.idx_properties_has_unread_inbound;
drop index if exists public.idx_properties_has_open_tasks;
drop index if exists public.idx_properties_has_inbound_message;
drop index if exists public.idx_properties_attempted;
alter table public.properties set (fillfactor = 90);

-- Cheaper comparator. Fast path: copy the cache + known generated columns from OLD into a copy of NEW
-- and compare whole rows (no jsonb). Anything the static copy cannot prove (e.g. a generated column added
-- later) falls back to the catalog-derived jsonb comparison, so semantics are identical to 20261002110000.
create or replace function public.properties_filter_cache_only_change(old_row public.properties, new_row public.properties)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.properties;
  v_res boolean;
begin
  if (new_row.has_inbound_message, new_row.has_outbound_message, new_row.has_unread_inbound, new_row.has_open_tasks,
      new_row.filter_list_ids, new_row.filter_tag_ids, new_row.filter_list_count)
     is not distinct from
     (old_row.has_inbound_message, old_row.has_outbound_message, old_row.has_unread_inbound, old_row.has_open_tasks,
      old_row.filter_list_ids, old_row.filter_tag_ids, old_row.filter_list_count) then
    return false; -- no cache column changed
  end if;
  r := new_row;
  r.has_inbound_message := old_row.has_inbound_message;
  r.has_outbound_message := old_row.has_outbound_message;
  r.has_unread_inbound := old_row.has_unread_inbound;
  r.has_open_tasks := old_row.has_open_tasks;
  r.filter_list_ids := old_row.filter_list_ids;
  r.filter_tag_ids := old_row.filter_tag_ids;
  r.filter_list_count := old_row.filter_list_count;
  r.search_text := old_row.search_text;
  r.equity_pct := old_row.equity_pct;
  if r is not distinct from old_row then
    return true;
  end if;
  -- slow, catalog-derived path (generated columns added after this migration)
  select (j.n - j.ign) = (j.o - j.ign) and (j.n - j.gen) <> (j.o - j.gen)
    into v_res
    from (
      select g.n, g.o, g.gen,
             g.gen || array['has_inbound_message','has_outbound_message','has_unread_inbound','has_open_tasks','filter_list_ids','filter_tag_ids','filter_list_count']::text[] as ign
        from (
          select pg_catalog.to_jsonb(new_row) as n,
                 pg_catalog.to_jsonb(old_row) as o,
                 coalesce((select pg_catalog.array_agg(a.attname::text)
                             from pg_catalog.pg_attribute a
                            where a.attrelid = 'public.properties'::pg_catalog.regclass
                              and a.attnum > 0 and not a.attisdropped and a.attgenerated <> ''), '{}'::text[]) as gen
        ) g
    ) j;
  return coalesce(v_res, false);
end;
$$;

create or replace function public.refresh_property_filter_cache(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text;
begin
  if p_ids is null or pg_catalog.cardinality(p_ids) = 0 then
    return;
  end if;
  -- Same lock order as the global DNC write barrier (acquire_global_dnc_write_
  -- barrier): the shared barrier FIRST, then row locks, so a cache refresh can
  -- never invert against the exclusive global-DNC writer.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0)
  );
  -- Serialise writers per property (NO KEY UPDATE does not conflict with the
  -- FOR KEY SHARE an FK insert holds, so no deadlock with child inserts).
  perform 1 from public.properties p where p.id = any (p_ids) order by p.id for no key update;
  -- Fresh statement => fresh snapshot: sees rows committed by writers we waited on.
  v_prev := coalesce(pg_catalog.current_setting('sandra.filter_cache_writer', true), 'off');
  perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
  update public.properties p
     set has_inbound_message = c.hi,
         has_outbound_message = c.ho,
         has_unread_inbound = c.hu,
         has_open_tasks = c.ot,
         filter_list_ids = c.lids,
         filter_tag_ids = c.tids,
         filter_list_count = pg_catalog.cardinality(c.lids)
    from (
      select q.id, q.org_id,
        exists (select 1 from public.messages m where m.property_id = q.id and m.org_id = q.org_id and m.direction = 'inbound') as hi,
        exists (select 1 from public.messages m where m.property_id = q.id and m.org_id = q.org_id and m.direction = 'outbound') as ho,
        exists (select 1 from public.messages m where m.property_id = q.id and m.org_id = q.org_id and m.direction = 'inbound' and m.read_at is null) as hu,
        exists (select 1 from public.tasks t where t.related_property_id = q.id and t.org_id = q.org_id and t.status = 'open') as ot,
        coalesce((select pg_catalog.array_agg(pl.list_id order by pl.list_id) from public.property_lists pl where pl.property_id = q.id and pl.org_id = q.org_id), '{}'::uuid[]) as lids,
        coalesce((select pg_catalog.array_agg(pt.tag_id order by pt.tag_id) from public.property_tags pt where pt.property_id = q.id and pt.org_id = q.org_id), '{}'::uuid[]) as tids
      from public.properties q
      where q.id = any (p_ids)
    ) c
   where p.id = c.id
     and (p.has_inbound_message, p.has_outbound_message, p.has_unread_inbound, p.has_open_tasks, p.filter_list_ids, p.filter_tag_ids, p.filter_list_count)
         is distinct from (c.hi, c.ho, c.hu, c.ot, c.lids, c.tids, pg_catalog.cardinality(c.lids));
  perform pg_catalog.set_config('sandra.filter_cache_writer', v_prev, true);
end;
$$;

create or replace function public.trg_messages_refresh_filter_cache()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text;
  v_n integer;
begin
  if tg_op = 'INSERT' then
    -- Multi-property statement: take the ENTIRE affected set in ONE consistent id order before any
    -- update (no share/skip phase), so two overlapping batches (or a batch and a full refresh, which also
    -- locks in id order) can never wait on each other in opposite orders.
    select count(distinct n.property_id) into v_n from new_rows n join public.properties q on q.id = n.property_id where n.property_id is not null and n.org_id = q.org_id;
    if v_n > 1 then
      perform pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
      perform 1 from public.properties p where p.id in (select n.property_id from new_rows n where n.property_id is not null and n.org_id = p.org_id) order by p.id for no key update;
      v_prev := coalesce(pg_catalog.current_setting('sandra.filter_cache_writer', true), 'off');
      perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
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
      perform pg_catalog.set_config('sandra.filter_cache_writer', v_prev, true);
    else
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
    v_prev := coalesce(pg_catalog.current_setting('sandra.filter_cache_writer', true), 'off');
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
    -- a) incremental, monotonic (OR-only) set of the flags the new rows imply; the guarded UPDATE row-locks
    --    (FOR NO KEY UPDATE) exactly the properties that need a change.
    perform 1 from public.properties p
      join (select n.property_id as id, n.org_id,
                   pg_catalog.bool_or(n.direction = 'inbound') as hi,
                   pg_catalog.bool_or(n.direction = 'outbound') as ho,
                   pg_catalog.bool_or(n.direction = 'inbound' and n.read_at is null) as hu
              from new_rows n where n.property_id is not null group by n.property_id, n.org_id) a
        on p.id = a.id and p.org_id = a.org_id
     where (a.hi and not p.has_inbound_message) or (a.ho and not p.has_outbound_message) or (a.hu and not p.has_unread_inbound)
     order by p.id for no key update of p;
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
    perform 1 from public.properties p
      join (select n.property_id as id, n.org_id,
                   pg_catalog.bool_or(n.direction = 'inbound') as hi,
                   pg_catalog.bool_or(n.direction = 'outbound') as ho,
                   pg_catalog.bool_or(n.direction = 'inbound' and n.read_at is null) as hu
              from new_rows n where n.property_id is not null group by n.property_id, n.org_id) a
        on p.id = a.id and p.org_id = a.org_id
     where (a.hi and not p.has_inbound_message) or (a.ho and not p.has_outbound_message) or (a.hu and not p.has_unread_inbound)
     order by p.id for no key update of p;
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
    perform pg_catalog.set_config('sandra.filter_cache_writer', v_prev, true);
    end if;
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
declare
  v_prev text;
  v_n integer;
begin
  if tg_op = 'INSERT' then
    -- Multi-property statement: take the ENTIRE affected set in ONE consistent id order before any
    -- update (no share/skip phase), so two overlapping batches (or a batch and a full refresh, which also
    -- locks in id order) can never wait on each other in opposite orders.
    select count(distinct n.related_property_id) into v_n from new_rows n join public.properties q on q.id = n.related_property_id where n.status = 'open' and n.org_id = q.org_id;
    if v_n > 1 then
      perform pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
      perform 1 from public.properties p where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id) order by p.id for no key update;
      v_prev := coalesce(pg_catalog.current_setting('sandra.filter_cache_writer', true), 'off');
      perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
      update public.properties p set has_open_tasks = true
       where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id)
         and not p.has_open_tasks;
      perform pg_catalog.set_config('sandra.filter_cache_writer', v_prev, true);
    else
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
    v_prev := coalesce(pg_catalog.current_setting('sandra.filter_cache_writer', true), 'off');
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
    perform 1 from public.properties p
     where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id)
       and not p.has_open_tasks
     order by p.id for no key update;
    update public.properties p set has_open_tasks = true
     where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id)
       and not p.has_open_tasks;
    perform 1 from public.properties p
     where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id)
     order by p.id for share;
    perform 1 from public.properties p
     where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id)
       and not p.has_open_tasks
     order by p.id for no key update;
    update public.properties p set has_open_tasks = true
     where p.id in (select n.related_property_id from new_rows n where n.status = 'open' and n.org_id = p.org_id)
       and not p.has_open_tasks;
    perform pg_catalog.set_config('sandra.filter_cache_writer', v_prev, true);
    end if;
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
declare
  v_prev text;
begin
  if tg_op = 'INSERT' then
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
    v_prev := coalesce(pg_catalog.current_setting('sandra.filter_cache_writer', true), 'off');
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
    -- Unconditional (rare) incremental merge: unique (property_id, list_id) means ids never repeat; the merge is
    -- deduplicated and sorted exactly like the full refresh, and the UPDATE row-locks the property.
    perform 1 from public.properties p
     where p.id in (select n.property_id from new_rows n where n.org_id = p.org_id)
     order by p.id for no key update;
    update public.properties p
       set filter_list_ids = (select coalesce(pg_catalog.array_agg(distinct x order by x), '{}'::uuid[]) from unnest(p.filter_list_ids || a.ids) x),
           filter_list_count = (select pg_catalog.count(distinct x) from unnest(p.filter_list_ids || a.ids) x)::integer
      from (select n.property_id as id, n.org_id, pg_catalog.array_agg(n.list_id) as ids
              from new_rows n group by n.property_id, n.org_id) a
     where p.id = a.id and p.org_id = a.org_id;
    perform pg_catalog.set_config('sandra.filter_cache_writer', v_prev, true);
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
declare
  v_prev text;
begin
  if tg_op = 'INSERT' then
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
    v_prev := coalesce(pg_catalog.current_setting('sandra.filter_cache_writer', true), 'off');
    perform pg_catalog.set_config('sandra.filter_cache_writer', 'on', true);
    -- Unconditional (rare) incremental merge: unique (property_id, tag_id) means ids never repeat; the merge is
    -- deduplicated and sorted exactly like the full refresh, and the UPDATE row-locks the property.
    perform 1 from public.properties p
     where p.id in (select n.property_id from new_rows n where n.org_id = p.org_id)
     order by p.id for no key update;
    update public.properties p
       set filter_tag_ids = (select coalesce(pg_catalog.array_agg(distinct x order by x), '{}'::uuid[]) from unnest(p.filter_tag_ids || a.ids) x)
      from (select n.property_id as id, n.org_id, pg_catalog.array_agg(n.tag_id) as ids
              from new_rows n group by n.property_id, n.org_id) a
     where p.id = a.id and p.org_id = a.org_id;
    perform pg_catalog.set_config('sandra.filter_cache_writer', v_prev, true);
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
