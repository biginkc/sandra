-- Denormalised filter-cache columns on public.properties, maintained by
-- triggers, so the Prospects/Search filter translator can filter plain
-- columns (works on from('properties') AND on `setof properties` rpc builders,
-- no embedded-resource filters, no pre-fetched id lists, no unbounded reads).
--
-- Why not computed fields: stable SQL functions over a properties row cannot
-- inline on PostgreSQL 17 (subquery bodies), so they execute once per
-- candidate row. Measured on a 50k-property / 250k-message stack they were
-- 10x-460x slower than the legacy translator (see PR A volume gate), far over
-- the 2x budget. This is the plan's mandatory set-based fallback.
--
-- Columns (never NULL):
--   has_inbound_message / has_outbound_message  any message (any channel) with property_id
--   has_unread_inbound                          inbound message with read_at IS NULL
--   has_open_tasks                              task with status = 'open'
--   filter_list_ids / filter_tag_ids            property_lists.list_id / property_tags.tag_id
--   filter_list_count                           number of property_lists rows
-- Only child rows whose org_id equals the property's org_id count (this
-- matches what a correctly-scoped RLS viewer sees).
--
-- Maintenance: statement-level triggers (transition tables) on messages,
-- tasks, property_lists and property_tags call refresh_property_filter_cache
-- with the DISTINCT affected property ids (bulk imports cost one set-based
-- refresh per statement, not one per row). The refresh row-locks the affected
-- properties (FOR NO KEY UPDATE, id order) before recomputing in a fresh
-- statement, so concurrent writers serialise instead of overwriting each
-- other with stale snapshots. UPDATEs only happen when a value changes.
--
-- Safety interplay (reviewed): properties are read-only once DNC-locked and
-- some BEFORE UPDATE triggers take advisory locks. Child writes to a locked
-- property (e.g. an inbound STOP reply) must still refresh the cache, so
-- properties_true_dnc_lock_guard and serialize_property_safety_before_csv_
-- consent now return early ONLY for an UPDATE that changes nothing except
-- these cache columns (properties_filter_cache_only_change). Every other
-- update path is byte-for-byte unchanged. A pin trigger resets the cache
-- columns for any writer other than the refresh function, so clients cannot
-- forge them through PostgREST.
--
-- Additive; apply BEFORE the app code that filters these columns is deployed.
-- Backfill is deliberately NOT here (it would hold the DDL transaction's locks
-- for its whole runtime): see 20261002110050_properties_filter_cache_backfill.sql.

set lock_timeout = '5s';

begin;

-- Acquire every table lock this migration needs UP FRONT, child tables first and
-- properties last: concurrent DML (message insert -> training guard reads
-- properties) takes locks in that order, so interleaving with piecemeal DDL
-- locks produced a deadlock (40P01) for a concurrent insert in a cold-run probe.
-- lock_timeout (5s, above) makes this fail cleanly instead of queueing forever.
lock table public.messages, public.tasks, public.property_lists, public.property_tags, public.properties in access exclusive mode;

alter table public.properties
  add column if not exists has_inbound_message boolean not null default false,
  add column if not exists has_outbound_message boolean not null default false,
  add column if not exists has_unread_inbound boolean not null default false,
  add column if not exists has_open_tasks boolean not null default false,
  add column if not exists filter_list_ids uuid[] not null default '{}'::uuid[],
  add column if not exists filter_tag_ids uuid[] not null default '{}'::uuid[],
  add column if not exists filter_list_count integer not null default 0;

-- True only when OLD and NEW differ and every difference is a cache column.
-- Stored generated columns (search_text, equity_pct, and any added later) are not yet
-- computed in BEFORE triggers, so they are ignored; the list is DERIVED from the catalog
-- (pg_attribute.attgenerated), never hard-coded, so a future generated column cannot make
-- STOP replies on DNC-locked rows fail. They derive from other columns that ARE compared.
create or replace function public.properties_filter_cache_only_change(old_row public.properties, new_row public.properties)
returns boolean
language sql
stable
set search_path = ''
as $$
  select (j.n - j.ign) = (j.o - j.ign)
     and (j.n - j.gen) <> (j.o - j.gen)
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
    ) j
$$;

-- Forged writes to the cache columns are discarded; only the refresh function
-- (which sets sandra.filter_cache_writer for its own statement) may change them.
create or replace function public.properties_filter_cache_pin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The GUC alone is not trusted: the writer must also be running as the
  -- owner of refresh_property_filter_cache (inside its SECURITY DEFINER body).
  if coalesce(pg_catalog.current_setting('sandra.filter_cache_writer', true), 'off') = 'on'
     and current_user = (
       select pg_catalog.pg_get_userbyid(p.proowner)
         from pg_catalog.pg_proc p
        where p.oid = 'public.refresh_property_filter_cache(uuid[])'::pg_catalog.regprocedure
     )
  then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.has_inbound_message := false;
    new.has_outbound_message := false;
    new.has_unread_inbound := false;
    new.has_open_tasks := false;
    new.filter_list_ids := '{}'::uuid[];
    new.filter_tag_ids := '{}'::uuid[];
    new.filter_list_count := 0;
  else
    new.has_inbound_message := old.has_inbound_message;
    new.has_outbound_message := old.has_outbound_message;
    new.has_unread_inbound := old.has_unread_inbound;
    new.has_open_tasks := old.has_open_tasks;
    new.filter_list_ids := old.filter_list_ids;
    new.filter_tag_ids := old.filter_tag_ids;
    new.filter_list_count := old.filter_list_count;
  end if;
  return new;
end;
$$;

-- Sorts before guard_training_property / properties_true_dnc_lock_guard.
drop trigger if exists a_properties_filter_cache_pin on public.properties;
create trigger a_properties_filter_cache_pin
  before insert or update on public.properties
  for each row execute function public.properties_filter_cache_pin();

-- Cache-only updates must not trip the DNC read-only guard or take the
-- consent advisory lock. Bodies are the live definitions plus one early return.
CREATE OR REPLACE FUNCTION public.properties_true_dnc_lock_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  linked_contact_is_dnc boolean := false;
  authoritative_dnc boolean := false;
begin
  if tg_op = 'UPDATE' and public.properties_filter_cache_only_change(old, new) then
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.is_dnc_locked then
      raise exception using
        errcode = 'P0001',
        message = 'DNC_LOCKED: permanently locked properties cannot be deleted';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.is_dnc_locked and not new.is_dnc_locked then
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCKED: permanent lock cannot be cleared';
  end if;

  if tg_op = 'UPDATE' and old.is_dnc_locked and new is distinct from old then
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCKED: permanently locked properties are read-only';
  end if;

  if new.homeowner_contact_id is not null then
    select coalesce(c.do_not_contact, false)
      into linked_contact_is_dnc
    from public.contacts c
    where c.id = new.homeowner_contact_id
      and c.org_id = new.org_id;
  end if;

  authoritative_dnc := new.outreach_dispo = 'dnc' or linked_contact_is_dnc;

  if new.is_dnc_locked and not authoritative_dnc then
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCK_INVALID: lock requires an authoritative DNC signal';
  end if;

  if authoritative_dnc then
    new.is_dnc_locked := true;
    -- A concurrent promotion or disposition write must not move a property as
    -- it becomes DNC.  The last historical status remains its audit trail.
    if tg_op = 'UPDATE' then
      new.status := old.status;
    end if;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.serialize_property_safety_before_csv_consent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if tg_op = 'UPDATE' and public.properties_filter_cache_only_change(old, new) then
    return new;
  end if;
  if new.homeowner_contact_id is not null
    and (
      (new.is_dnc_locked and not old.is_dnc_locked)
      or new.outreach_dispo in ('wrong_number', 'bad_number', 'dnc', 'opted_out')
    )
  then
    perform public.lock_csv_import_consent_org(new.org_id);
  end if;
  return new;
end;
$function$;

-- Recompute the cache for the given properties.
-- NOTE: properties_filter_cache_pin trusts the writer GUC only when current_user equals the OWNER of
-- this exact function (looked up by regprocedure 'public.refresh_property_filter_cache(uuid[])'); renaming
-- or changing the signature/owner of this function requires updating the pin trigger in the same migration.
create or replace function public.refresh_property_filter_cache(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
  perform pg_catalog.set_config('sandra.filter_cache_writer', 'off', true);
end;
$$;

-- One statement-level trigger function per child table. Transition tables
-- exist only for the matching event, so each branch references only its own.
create or replace function public.trg_messages_refresh_filter_cache()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.refresh_property_filter_cache(array(select distinct n.property_id from new_rows n where n.property_id is not null));
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
    perform public.refresh_property_filter_cache(array(select distinct n.related_property_id from new_rows n));
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
    perform public.refresh_property_filter_cache(array(select distinct n.property_id from new_rows n));
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
    perform public.refresh_property_filter_cache(array(select distinct n.property_id from new_rows n));
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

-- A property moving to another org changes which child rows count (children are
-- matched on org_id). The pin trigger preserves the old cache values, so refresh here.
create or replace function public.trg_properties_org_change_refresh_filter_cache()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.refresh_property_filter_cache(array[new.id]);
  return null;
end;
$$;

drop trigger if exists zz_properties_filter_cache_org_change on public.properties;
create trigger zz_properties_filter_cache_org_change
  after update of org_id on public.properties
  for each row
  when (old.org_id is distinct from new.org_id)
  execute function public.trg_properties_org_change_refresh_filter_cache();

drop trigger if exists zz_messages_filter_cache_insert on public.messages;
create trigger zz_messages_filter_cache_insert
  after insert on public.messages
  referencing new table as new_rows
  for each statement execute function public.trg_messages_refresh_filter_cache();

drop trigger if exists zz_messages_filter_cache_update on public.messages;
create trigger zz_messages_filter_cache_update
  after update on public.messages
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.trg_messages_refresh_filter_cache();

drop trigger if exists zz_messages_filter_cache_delete on public.messages;
create trigger zz_messages_filter_cache_delete
  after delete on public.messages
  referencing old table as old_rows
  for each statement execute function public.trg_messages_refresh_filter_cache();

drop trigger if exists zz_tasks_filter_cache_insert on public.tasks;
create trigger zz_tasks_filter_cache_insert
  after insert on public.tasks
  referencing new table as new_rows
  for each statement execute function public.trg_tasks_refresh_filter_cache();

drop trigger if exists zz_tasks_filter_cache_update on public.tasks;
create trigger zz_tasks_filter_cache_update
  after update on public.tasks
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.trg_tasks_refresh_filter_cache();

drop trigger if exists zz_tasks_filter_cache_delete on public.tasks;
create trigger zz_tasks_filter_cache_delete
  after delete on public.tasks
  referencing old table as old_rows
  for each statement execute function public.trg_tasks_refresh_filter_cache();

drop trigger if exists zz_property_lists_filter_cache_insert on public.property_lists;
create trigger zz_property_lists_filter_cache_insert
  after insert on public.property_lists
  referencing new table as new_rows
  for each statement execute function public.trg_property_lists_refresh_filter_cache();

drop trigger if exists zz_property_lists_filter_cache_update on public.property_lists;
create trigger zz_property_lists_filter_cache_update
  after update on public.property_lists
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.trg_property_lists_refresh_filter_cache();

drop trigger if exists zz_property_lists_filter_cache_delete on public.property_lists;
create trigger zz_property_lists_filter_cache_delete
  after delete on public.property_lists
  referencing old table as old_rows
  for each statement execute function public.trg_property_lists_refresh_filter_cache();

drop trigger if exists zz_property_tags_filter_cache_insert on public.property_tags;
create trigger zz_property_tags_filter_cache_insert
  after insert on public.property_tags
  referencing new table as new_rows
  for each statement execute function public.trg_property_tags_refresh_filter_cache();

drop trigger if exists zz_property_tags_filter_cache_update on public.property_tags;
create trigger zz_property_tags_filter_cache_update
  after update on public.property_tags
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.trg_property_tags_refresh_filter_cache();

drop trigger if exists zz_property_tags_filter_cache_delete on public.property_tags;
create trigger zz_property_tags_filter_cache_delete
  after delete on public.property_tags
  referencing old table as old_rows
  for each statement execute function public.trg_property_tags_refresh_filter_cache();

revoke all on function public.refresh_property_filter_cache(uuid[]) from public, anon, authenticated;
grant execute on function public.refresh_property_filter_cache(uuid[]) to service_role;
revoke all on function public.trg_properties_org_change_refresh_filter_cache() from public, anon, authenticated;
revoke all on function public.trg_messages_refresh_filter_cache() from public, anon, authenticated;
revoke all on function public.trg_tasks_refresh_filter_cache() from public, anon, authenticated;
revoke all on function public.trg_property_lists_refresh_filter_cache() from public, anon, authenticated;
revoke all on function public.trg_property_tags_refresh_filter_cache() from public, anon, authenticated;
-- properties_filter_cache_only_change is a pure comparator: default PUBLIC execute is kept on purpose.

-- Indexes for org-wide filters (no market predicate): partial btrees keep the
-- selective boolean states cheap; GIN serves the uuid[] overlap/contains.
create index if not exists idx_properties_has_unread_inbound on public.properties (org_id) where has_unread_inbound;
create index if not exists idx_properties_has_open_tasks on public.properties (org_id) where has_open_tasks;
create index if not exists idx_properties_has_inbound_message on public.properties (org_id) where has_inbound_message;
create index if not exists idx_properties_attempted on public.properties (org_id) where has_outbound_message and not has_inbound_message;
create index if not exists idx_properties_filter_list_ids on public.properties using gin (filter_list_ids);
create index if not exists idx_properties_filter_tag_ids on public.properties using gin (filter_tag_ids);

commit;

notify pgrst, 'reload schema';
