-- Rollback for 20261031120000_homeowner_from_property_links.
--
-- Clears homeowner_contact_id only on the rows the backfill wrote (recorded
-- in homeowner_link_backfill) and only where it still holds the backfilled
-- value, then restores the import functions to their 20261027222111 /
-- 20260924180619 bodies. A homeowner set since by a person or a later import
-- is left alone.
--
-- A lead the backfill wrote can have become DNC-locked since (its homeowner
-- opted out, say). Locked rows are read-only by trigger, so those are
-- skipped, reported with RAISE NOTICE, and their ledger rows are kept: the
-- table is dropped only when every row was undone.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '180s';

update public.properties p
set homeowner_contact_id = null
from public.homeowner_link_backfill b
where p.id = b.property_id
  and p.org_id = b.org_id
  and p.homeowner_contact_id = b.contact_id
  and not p.is_dnc_locked;

do $$
declare
  v_skipped integer;
  v_ids text;
begin
  select count(*), string_agg(b.property_id::text, ', ' order by b.property_id)
    into v_skipped, v_ids
  from public.homeowner_link_backfill b
  join public.properties p on p.id = b.property_id and p.org_id = b.org_id
  where p.homeowner_contact_id = b.contact_id and p.is_dnc_locked;
  if v_skipped > 0 then
    raise notice 'homeowner_from_property_links rollback: % backfilled lead(s) are now DNC-locked and were left as-is; ledger rows kept in public.homeowner_link_backfill: %. Before re-applying the forward migration, review those rows and drop the table by hand (drop table public.homeowner_link_backfill), or create table will fail.', v_skipped, v_ids;
    delete from public.homeowner_link_backfill b
    where not exists (
      select 1 from public.properties p
      where p.id = b.property_id and p.org_id = b.org_id
        and p.homeowner_contact_id = b.contact_id and p.is_dnc_locked
    );
  else
    drop table public.homeowner_link_backfill;
  end if;
end;
$$;

create or replace function public.upsert_dealmachine_property_contact(
  p_property_id uuid,
  p_org_id uuid,
  p_source_identity text,
  p_source_position smallint,
  p_source_attributes jsonb,
  p_contact jsonb
) returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
  v_phone_1 text := nullif(p_contact->>'phone_1', '');
  v_phone_2 text := nullif(p_contact->>'phone_2', '');
  v_phone_3 text := nullif(p_contact->>'phone_3', '');
  v_email text := nullif(lower(p_contact->>'email'), '');
begin
  if nullif(btrim(p_source_identity), '') is null or length(p_source_identity) > 256 then
    raise exception 'DealMachine source identity is invalid';
  end if;
  if p_source_position not between 1 and 8 then
    raise exception 'DealMachine source position must be between 1 and 8';
  end if;
  if not exists (
    select 1 from public.properties
    where id = p_property_id and org_id = p_org_id
  ) then
    raise exception 'DealMachine property does not belong to the organization';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':dealmachine:' || p_source_identity, 0));
  select contact_id into v_contact_id
  from public.property_contacts
  where property_id = p_property_id
    and relationship = 'dealmachine_contact'
    and source_identity = p_source_identity;

  if v_contact_id is not null then
    if coalesce((p_contact->>'do_not_contact')::boolean, false) then
      update public.contacts set do_not_contact = true where id = v_contact_id and org_id = p_org_id and do_not_contact = false;
    end if;
    update public.property_contacts
    set source_position = p_source_position,
        source_attributes = p_source_attributes,
        updated_at = now()
    where property_id = p_property_id
      and relationship = 'dealmachine_contact'
      and source_identity = p_source_identity;
    return v_contact_id;
  end if;

  select id into v_contact_id
  from public.contacts
  where org_id = p_org_id
    and (
      (v_phone_1 is not null and (phone_1 = v_phone_1 or phone_2 = v_phone_1 or phone_3 = v_phone_1))
      or (v_phone_2 is not null and (phone_1 = v_phone_2 or phone_2 = v_phone_2 or phone_3 = v_phone_2))
      or (v_phone_3 is not null and (phone_1 = v_phone_3 or phone_2 = v_phone_3 or phone_3 = v_phone_3))
    )
  order by created_at asc
  limit 1;

  if v_contact_id is null and v_email is not null then
    select id into v_contact_id
    from public.contacts
    where org_id = p_org_id and lower(email) = v_email
    order by created_at asc
    limit 1;
  end if;

  if v_contact_id is null
    and v_phone_1 is null and v_phone_2 is null and v_phone_3 is null
    and v_email is null
    and nullif(p_contact->>'first_name', '') is not null
    and nullif(p_contact->>'last_name', '') is not null then
    select id into v_contact_id
    from public.contacts
    where org_id = p_org_id
      and contact_type = 'person'
      and phone_1 is null
      and email is null
      and lower(first_name) = lower(p_contact->>'first_name')
      and lower(last_name) = lower(p_contact->>'last_name')
    limit 1;
  end if;

  if v_contact_id is null then
    insert into public.contacts (
      org_id, contact_type, first_name, last_name, entity_name,
      phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, email, do_not_contact
    ) values (
      p_org_id, coalesce(nullif(p_contact->>'contact_type', ''), 'person'),
      nullif(p_contact->>'first_name', ''), nullif(p_contact->>'last_name', ''),
      nullif(p_contact->>'entity_name', ''), v_phone_1,
      coalesce(nullif(p_contact->>'phone_1_type', ''), 'unknown'), v_phone_2,
      coalesce(nullif(p_contact->>'phone_2_type', ''), 'unknown'), v_phone_3,
      coalesce(nullif(p_contact->>'phone_3_type', ''), 'unknown'), v_email, coalesce((p_contact->>'do_not_contact')::boolean, false)
    ) returning id into v_contact_id;
  end if;

  if coalesce((p_contact->>'do_not_contact')::boolean, false) then
    update public.contacts set do_not_contact = true where id = v_contact_id and org_id = p_org_id and do_not_contact = false;
  end if;
  insert into public.property_contacts (
    property_id, contact_id, org_id, relationship, source_identity,
    source_position, source_attributes
  ) values (
    p_property_id, v_contact_id, p_org_id, 'dealmachine_contact', p_source_identity,
    p_source_position, p_source_attributes
  );
  return v_contact_id;
end;
$$;

create or replace function public.upsert_assigns_property_contact(
  p_property_id uuid,
  p_org_id uuid,
  p_source_identity text,
  p_source_position smallint,
  p_source_attributes jsonb,
  p_contact jsonb
) returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
  v_phone_1 text := nullif(p_contact->>'phone_1', '');
  v_phone_2 text := nullif(p_contact->>'phone_2', '');
  v_phone_3 text := nullif(p_contact->>'phone_3', '');
  v_email text := nullif(lower(p_contact->>'email'), '');
begin
  if p_source_identity !~ '^[^:]+:[1-8]:[0-9a-f]{8}$' then
    raise exception 'Assigns source identity is invalid';
  end if;
  if p_source_position not between 1 and 8 then
    raise exception 'Assigns source position must be between 1 and 8';
  end if;
  if not exists (
    select 1 from public.properties
    where id = p_property_id and org_id = p_org_id
  ) then
    raise exception 'Assigns property does not belong to the organization';
  end if;

  select contact_id into v_contact_id
  from public.property_contacts
  where property_id = p_property_id
    and relationship = 'assigns_contact'
    and source_identity = p_source_identity;

  if v_contact_id is not null then
    update public.property_contacts
    set source_position = p_source_position,
        source_attributes = p_source_attributes,
        updated_at = now()
    where property_id = p_property_id
      and relationship = 'assigns_contact'
      and source_identity = p_source_identity;
    return v_contact_id;
  end if;

  select id into v_contact_id
  from public.contacts
  where org_id = p_org_id
    and (
      (v_phone_1 is not null and (phone_1 = v_phone_1 or phone_2 = v_phone_1 or phone_3 = v_phone_1))
      or (v_phone_2 is not null and (phone_1 = v_phone_2 or phone_2 = v_phone_2 or phone_3 = v_phone_2))
      or (v_phone_3 is not null and (phone_1 = v_phone_3 or phone_2 = v_phone_3 or phone_3 = v_phone_3))
    )
  order by created_at asc
  limit 1;

  if v_contact_id is null and v_email is not null then
    select id into v_contact_id
    from public.contacts
    where org_id = p_org_id and lower(email) = v_email
    order by created_at asc
    limit 1;
  end if;

  if v_contact_id is null
    and v_phone_1 is null and v_phone_2 is null and v_phone_3 is null
    and v_email is null
    and nullif(p_contact->>'first_name', '') is not null
    and nullif(p_contact->>'last_name', '') is not null then
    select id into v_contact_id
    from public.contacts
    where org_id = p_org_id
      and contact_type = 'person'
      and phone_1 is null
      and email is null
      and lower(first_name) = lower(p_contact->>'first_name')
      and lower(last_name) = lower(p_contact->>'last_name')
    limit 1;
  end if;

  if v_contact_id is null then
    insert into public.contacts (
      org_id, contact_type, first_name, last_name, entity_name,
      phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, email
    ) values (
      p_org_id, coalesce(nullif(p_contact->>'contact_type', ''), 'person'),
      nullif(p_contact->>'first_name', ''), nullif(p_contact->>'last_name', ''),
      nullif(p_contact->>'entity_name', ''), v_phone_1,
      coalesce(nullif(p_contact->>'phone_1_type', ''), 'unknown'), v_phone_2,
      coalesce(nullif(p_contact->>'phone_2_type', ''), 'unknown'), v_phone_3,
      coalesce(nullif(p_contact->>'phone_3_type', ''), 'unknown'), v_email
    ) returning id into v_contact_id;
  end if;

  insert into public.property_contacts (
    property_id, contact_id, org_id, relationship, source_identity,
    source_position, source_attributes
  ) values (
    p_property_id, v_contact_id, p_org_id, 'assigns_contact', p_source_identity,
    p_source_position, p_source_attributes
  );
  return v_contact_id;
end;
$$;

drop function if exists public.fill_homeowner_from_links(uuid, uuid);
drop function if exists public.resolve_homeowner_from_links(uuid, uuid);

commit;
