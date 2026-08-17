-- Contact deletion must preserve permanent DNC evidence while ordinary
-- parent-FK cleanup stays possible.
--
-- Two guards intersect when a contact is deleted:
--   1. contacts_reject_dnc_locked_property protects the parent contact.
--   2. tasks_reject_dnc_locked_contact protects contact/property-linked
--      tasks, including contact-only appointments.
--
-- The second guard used to call assert_contact_dnc_unlocked(OLD.contact_id)
-- while PostgreSQL was performing tasks.contact_id ON DELETE SET NULL. At
-- that nested trigger depth the parent contact is already absent from the
-- deleting statement's view, so an ordinary unlocked contact delete failed
-- with CONTACT_NOT_FOUND. The exception below is deliberately narrower than
-- “contact_id became NULL”: it requires a nested trigger AND a now-missing
-- same-org parent. A direct task update still evaluates the existing contact
-- and remains rejected when that contact is DNC.

begin;

create or replace function public.reject_locked_property_contact_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  linked_is_locked boolean;
begin
  if tg_op = 'UPDATE'
    and new.do_not_contact is true
    and old.do_not_contact is false
  then
    if (to_jsonb(new) - array['do_not_contact', 'updated_at'])
      is distinct from (to_jsonb(old) - array['do_not_contact', 'updated_at'])
    then
      raise exception using errcode = 'P0001', message = 'DNC_RATCHET_ONLY';
    end if;
    return new;
  end if;

  -- A contact's own DNC bit is authoritative even when it has no homeowner
  -- property. Never allow DELETE to erase that compliance record.
  if tg_op = 'DELETE' and old.do_not_contact then
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCKED: permanently locked contacts cannot be deleted';
  end if;

  perform 1 from public.properties property
  where property.homeowner_contact_id = old.id and property.org_id = old.org_id
  order by property.id
  for no key update;
  select exists (
    select 1 from public.properties property
    where property.homeowner_contact_id = old.id
      and property.org_id = old.org_id
      and property.is_dnc_locked
  ) into linked_is_locked;
  if linked_is_locked then
    raise exception using errcode = 'P0001', message = 'DNC_LOCKED: linked contact is read-only';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

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
  is_nested_missing_old_contact_cleanup boolean := false;
begin
  if tg_op <> 'INSERT' then
    old_contact_id := old.contact_id;
    old_property_id := old.related_property_id;
  end if;
  if tg_op <> 'DELETE' then
    new_contact_id := new.contact_id;
    new_property_id := new.related_property_id;
  end if;

  -- PostgreSQL's tasks_contact_org_fkey is the only accepted path that may
  -- clear a no-longer-visible parent without evaluating its DNC state. The
  -- parent contact guard above has already admitted only an unlocked delete.
  is_nested_missing_old_contact_cleanup := tg_op = 'UPDATE'
    and pg_trigger_depth() > 1
    and old.contact_id is not null
    and new.contact_id is null
    and new.org_id = old.org_id
    and not exists (
      select 1
      from public.contacts c
      where c.id = old.contact_id
        and c.org_id = old.org_id
    );

  for contact_id in
    select distinct candidate
    from unnest(array[old_contact_id, new_contact_id]) as values_to_check(candidate)
    where candidate is not null
    order by candidate
  loop
    -- Skip only the assertion whose parent row PostgreSQL has already made
    -- invisible. All other contact checks and, critically, every property
    -- lock check below still run before the FK cleanup may mutate the task.
    if not (
      is_nested_missing_old_contact_cleanup
      and contact_id = old.contact_id
    ) then
      perform public.assert_contact_dnc_unlocked(contact_id);
    end if;
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

commit;
