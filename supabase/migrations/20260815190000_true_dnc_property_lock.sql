-- True DNC is a permanent property-level compliance state.  It is deliberately
-- narrower than channel suppression: SMS opt-out, wrong/bad number, and the
-- durable SMS phone suppression table do not ratchet this record lock.

alter table public.properties
  add column if not exists is_dnc_locked boolean not null default false;

-- Preserve the historical pipeline status while promoting the two existing
-- authoritative DNC signals into the durable lock.
update public.properties p
set is_dnc_locked = true
where p.is_dnc_locked = false
  and (
    p.outreach_dispo = 'dnc'
    or exists (
      select 1
      from public.contacts c
      where c.id = p.homeowner_contact_id
        and c.org_id = p.org_id
        and c.do_not_contact is true
    )
  );

create index if not exists idx_properties_unlocked_leads
  on public.properties (org_id, status, created_at desc)
  where deleted_at is null
    and is_dnc_locked = false
    and status <> 'prospect';

create index if not exists idx_properties_locked_prospects
  on public.properties (org_id, created_at desc, id)
  where deleted_at is null
    and is_dnc_locked = true;

create or replace function public.properties_true_dnc_lock_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  linked_contact_is_dnc boolean := false;
  authoritative_dnc boolean := false;
begin
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
$$;

drop trigger if exists properties_true_dnc_lock_guard on public.properties;
create trigger properties_true_dnc_lock_guard
  before insert or update or delete on public.properties
  for each row execute function public.properties_true_dnc_lock_guard();

create or replace function public.contacts_true_dnc_lock_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and old.do_not_contact and not new.do_not_contact then
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCKED: contact do-not-contact cannot be cleared';
  end if;
  return new;
end;
$$;

drop trigger if exists contacts_true_dnc_lock_guard on public.contacts;
create trigger contacts_true_dnc_lock_guard
  before update on public.contacts
  for each row execute function public.contacts_true_dnc_lock_guard();

create or replace function public.contacts_propagate_true_dnc_lock()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.do_not_contact and (tg_op = 'INSERT' or not old.do_not_contact) then
    -- Canonical lock order for any contact/property operation: the contact
    -- row is already locked by this UPDATE, then linked properties by id.
    perform 1
    from public.properties p
    where p.homeowner_contact_id = new.id
      and p.org_id = new.org_id
    order by p.id
    for no key update;
    update public.properties p
    set is_dnc_locked = true
    where p.homeowner_contact_id = new.id
      and p.org_id = new.org_id
      and p.is_dnc_locked = false;
  end if;
  return new;
end;
$$;

drop trigger if exists contacts_propagate_true_dnc_lock on public.contacts;
create trigger contacts_propagate_true_dnc_lock
  after insert or update of do_not_contact on public.contacts
  for each row execute function public.contacts_propagate_true_dnc_lock();

create or replace function public.assert_property_dnc_unlocked(p_property_id uuid)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  property_is_locked boolean;
begin
  select p.is_dnc_locked
    into property_is_locked
  from public.properties p
  where p.id = p_property_id
    and p.deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'PROPERTY_NOT_FOUND';
  end if;

  if property_is_locked then
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCKED: permanently locked properties are read-only';
  end if;
end;
$$;

revoke all on function public.assert_property_dnc_unlocked(uuid)
  from public, anon;
grant execute on function public.assert_property_dnc_unlocked(uuid)
  to authenticated, service_role;

create or replace function public.assert_appointment_task_dnc_unlocked(p_task_id uuid)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  property_id uuid;
begin
  select t.related_property_id into property_id
  from public.tasks t
  where t.id = p_task_id;
  if property_id is not null then
    perform public.assert_property_dnc_unlocked(property_id);
  end if;
end;
$$;

revoke all on function public.assert_appointment_task_dnc_unlocked(uuid)
  from public, anon;
grant execute on function public.assert_appointment_task_dnc_unlocked(uuid)
  to authenticated, service_role;

-- Close side-table race windows. A server action can check the property and
-- then lose a race to a DNC update before its child-row write; these triggers
-- make the final database write authoritative as well.
create or replace function public.reject_locked_property_sidecar_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  property_id uuid;
  property_is_locked boolean;
  old_property_id uuid;
  new_property_id uuid;
begin
  if tg_op <> 'INSERT' then
    old_property_id := nullif(to_jsonb(old) ->> tg_argv[0], '')::uuid;
  end if;
  if tg_op <> 'DELETE' then
    new_property_id := nullif(to_jsonb(new) ->> tg_argv[0], '')::uuid;
  end if;

  for property_id in
    select distinct candidate
    from unnest(array[old_property_id, new_property_id]) as values_to_check(candidate)
    where candidate is not null
    order by candidate
  loop
    select p.is_dnc_locked into property_is_locked
    from public.properties p
    where p.id = property_id
    for no key update;
    if coalesce(property_is_locked, false) then
      raise exception using
        errcode = 'P0001',
        message = 'DNC_LOCKED: related records are read-only';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Contact-only appointments have no related_property_id for the generic
-- sidecar guard above. Lock the contact and every same-org property that
-- names it as homeowner before permitting a task write. This serializes the
-- booking with both authoritative ways a permanent DNC can ratchet.
create or replace function public.assert_contact_dnc_unlocked(p_contact_id uuid)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  contact_org_id uuid;
  contact_is_dnc boolean;
  linked_property_is_locked boolean := false;
begin
  select c.org_id, c.do_not_contact
  into contact_org_id, contact_is_dnc
  from public.contacts c
  where c.id = p_contact_id
  for no key update;

  if not found then
    raise exception using errcode = 'P0002', message = 'CONTACT_NOT_FOUND';
  end if;

  perform 1
  from public.properties p
  where p.homeowner_contact_id = p_contact_id
    and p.org_id = contact_org_id
  order by p.id
  for no key update;

  select exists (
    select 1 from public.properties p
    where p.homeowner_contact_id = p_contact_id
      and p.org_id = contact_org_id
      and p.is_dnc_locked
  ) into linked_property_is_locked;

  if contact_is_dnc or linked_property_is_locked then
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCKED: permanently locked contacts are read-only';
  end if;
end;
$$;

revoke all on function public.assert_contact_dnc_unlocked(uuid)
  from public, anon;
grant execute on function public.assert_contact_dnc_unlocked(uuid)
  to authenticated, service_role;

create or replace function public.reject_locked_contact_task_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  contact_id uuid;
  property_id uuid;
  property_is_locked boolean;
  old_contact_id uuid;
  new_contact_id uuid;
  old_property_id uuid;
  new_property_id uuid;
begin
  if tg_op <> 'INSERT' then
    old_contact_id := old.contact_id;
    old_property_id := old.related_property_id;
  end if;
  if tg_op <> 'DELETE' then
    new_contact_id := new.contact_id;
    new_property_id := new.related_property_id;
  end if;

  -- Match contact DNC propagation: CONTACT first, then PROPERTY, always in
  -- stable id order. One task trigger owns both associations so trigger-name
  -- ordering cannot invert the locks.
  for contact_id in
    select distinct candidate
    from unnest(array[old_contact_id, new_contact_id]) as values_to_check(candidate)
    where candidate is not null
    order by candidate
  loop
    perform public.assert_contact_dnc_unlocked(contact_id);
  end loop;
  for property_id in
    select distinct candidate
    from unnest(array[old_property_id, new_property_id]) as values_to_check(candidate)
    where candidate is not null
    order by candidate
  loop
    select p.is_dnc_locked into property_is_locked
    from public.properties p
    where p.id = property_id
    for no key update;
    if coalesce(property_is_locked, false) then
      raise exception using
        errcode = 'P0001',
        message = 'DNC_LOCKED: related records are read-only';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

do $$
begin
  if to_regclass('public.tasks') is not null then
    drop trigger if exists tasks_reject_dnc_locked_contact on public.tasks;
    drop trigger if exists tasks_reject_dnc_locked on public.tasks;
    create trigger tasks_reject_dnc_locked_contact
      before insert or update or delete on public.tasks
      for each row execute function public.reject_locked_contact_task_mutation();
  end if;
end;
$$;

-- Message delivery/provider fields must remain writable for inbound transport,
-- but acknowledging a locked conversation is a user mutation. Serialize only
-- read_at changes with the property lock so webhook ingestion remains intact.
create or replace function public.reject_locked_property_message_read_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  property_id uuid;
  property_is_locked boolean;
begin
  if new.read_at is not distinct from old.read_at then
    return new;
  end if;
  for property_id in
    select distinct candidate
    from unnest(array[old.property_id, new.property_id]) as values_to_check(candidate)
    where candidate is not null
    order by candidate
  loop
    select p.is_dnc_locked into property_is_locked
    from public.properties p
    where p.id = property_id
    for no key update;
    if coalesce(property_is_locked, false) then
      raise exception using
        errcode = 'P0001',
        message = 'DNC_LOCKED: message read state is read-only';
    end if;
  end loop;
  return new;
end;
$$;

do $$
begin
  if to_regclass('public.messages') is not null then
    drop trigger if exists messages_reject_dnc_locked_read on public.messages;
    create trigger messages_reject_dnc_locked_read
      before update of read_at on public.messages
      for each row execute function public.reject_locked_property_message_read_mutation();
  end if;
end;
$$;

do $$
declare
  target record;
begin
  for target in
    select * from (values
      ('tasks', 'related_property_id'),
      ('lead_notes', 'property_id'),
      ('property_lists', 'property_id'),
      ('property_tags', 'property_id'),
      ('dialer_batch_items', 'property_id')
    ) as t(table_name, property_column)
    where table_name <> 'tasks'
  loop
    if to_regclass('public.' || target.table_name) is not null then
      execute format(
        'drop trigger if exists %I on public.%I',
        target.table_name || '_reject_dnc_locked',
        target.table_name
      );
      execute format(
        'create trigger %I before insert or update or delete on public.%I '
        || 'for each row execute function public.reject_locked_property_sidecar_mutation(%L)',
        target.table_name || '_reject_dnc_locked',
        target.table_name,
        target.property_column
      );
    end if;
  end loop;
end;
$$;

create or replace function public.guard_locked_property_sequence_enrollment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  property_is_locked boolean;
begin
  select p.is_dnc_locked into property_is_locked
  from public.properties p
  where p.id = new.property_id
  for no key update;
  if coalesce(property_is_locked, false) then
    -- Compliance is allowed to stop an existing sequence after the lock
    -- ratchets; no other activation or mutation is allowed.
    if tg_op = 'UPDATE'
      and new.status in ('paused', 'opted_out', 'completed', 'cancelled')
      and old.status is distinct from new.status
    then
      return new;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCKED: sequence enrollment cannot be activated or changed';
  end if;
  return new;
end;
$$;

do $$
begin
  if to_regclass('public.sequence_enrollments') is not null then
    drop trigger if exists sequence_enrollments_reject_dnc_locked
      on public.sequence_enrollments;
    create trigger sequence_enrollments_reject_dnc_locked
      before insert or update on public.sequence_enrollments
      for each row execute function public.guard_locked_property_sequence_enrollment();
  end if;
end;
$$;

-- The historical cache was global by provider/address. Leads now uses it in a
-- tenant-scoped read model, so preserve every cache row for each organization
-- that owns a matching property and discard only rows that cannot be assigned
-- safely. New reads and writes are required to carry org_id.
alter table public.skip_trace_cache
  add column if not exists org_id uuid;

drop index if exists public.idx_skip_trace_cache_unique;

insert into public.skip_trace_cache (
  id,
  org_id,
  provider,
  address_normalized,
  result,
  match_count,
  cost_credits,
  created_at
)
select
  gen_random_uuid(),
  matches.org_id,
  cache.provider,
  cache.address_normalized,
  cache.result,
  cache.match_count,
  cache.cost_credits,
  cache.created_at
from public.skip_trace_cache cache
join public.properties matches
  on cache.result ->> 'propertyId' = matches.id::text
  and matches.deleted_at is null
  and array_to_string(
    array(
      select lower(trim(component))
      from unnest(array[matches.address, matches.city, matches.state, matches.zip])
        as address_parts(component)
      where component is not null
        and component <> ''
    ),
    '|'
  ) = cache.address_normalized
where cache.org_id is null;

delete from public.skip_trace_cache
where org_id is null;

alter table public.skip_trace_cache
  alter column org_id set not null;

create unique index if not exists idx_skip_trace_cache_org_provider_address
  on public.skip_trace_cache (org_id, provider, address_normalized);

drop policy if exists skip_trace_cache_authenticated_select
  on public.skip_trace_cache;
drop policy if exists skip_trace_cache_service_write
  on public.skip_trace_cache;

create policy skip_trace_cache_authenticated_select
  on public.skip_trace_cache
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.memberships membership
      where membership.org_id = skip_trace_cache.org_id
        and membership.user_id = auth.uid()
        and membership.access_status = 'active'
        and (
          membership.access_expires_at is null
          or membership.access_expires_at > now()
        )
    )
  );

create policy skip_trace_cache_service_write
  on public.skip_trace_cache
  for all
  to service_role
  using (true)
  with check (true);

-- Recreate the two board views so locked rows are never observable through a
-- stale Leads query, regardless of their preserved pipeline status.
drop view if exists public.leads_unskip_traced;
drop view if exists public.leads_board;

create view public.leads_board
with (security_invoker = true)
as
select
  p.id,
  p.address,
  p.city,
  p.state,
  p.zip,
  p.market,
  p.status,
  p.is_vacant,
  p.cass_status,
  p.absentee_flag,
  p.assigned_user_id,
  p.motivation_level,
  p.outreach_dispo,
  p.is_dnc_locked,
  p.deleted_at,
  p.created_at,
  case when hc.id is null then null else jsonb_build_object(
    'first_name', hc.first_name,
    'last_name', hc.last_name,
    'entity_name', hc.entity_name
  ) end as homeowner,
  exists (
    select 1
    from public.messages m
    where m.property_id = p.id
      and m.direction = 'inbound'
      and m.read_at is null
  ) as has_unread
from public.properties p
left join public.contacts hc
  on hc.id = p.homeowner_contact_id
  and hc.org_id = p.org_id
where p.is_dnc_locked = false;

create view public.leads_unskip_traced
with (security_invoker = true)
as
select b.*
from public.leads_board b
where b.is_dnc_locked = false
  and not exists (
    select 1
    from public.skip_trace_cache st
    where st.org_id = (
      select p.org_id from public.properties p where p.id = b.id
    )
      and st.address_normalized = array_to_string(
        array(
          select lower(trim(component))
          from unnest(array[b.address, b.city, b.state, b.zip]) as address_parts(component)
          where component is not null
            and component <> ''
        ),
        '|'
      )
  );

grant select on public.leads_board, public.leads_unskip_traced
  to authenticated, service_role;
