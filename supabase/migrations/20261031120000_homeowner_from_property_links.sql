-- Leads imported through property_contacts (DealMachine person rows since
-- 2026-10-22, Assigns contact blocks) link people to the property but leave
-- properties.homeowner_contact_id empty. Every surface keyed on that column
-- (Norma "Have Norma call", the SQL eligibility check, Send SMS, drips,
-- booking) then sees nobody to contact. PRs #936/#938 added read-side
-- fallbacks for texting and drips; Norma reads the column directly and was
-- never covered. This migration fills the column at the source:
--
--   1. resolve_homeowner_from_links(property, org): one rule for "who is the
--      homeowner" when the column is empty. Same precedence as
--      src/lib/leads/effective-homeowner.ts (the newest inbound SMS sender,
--      then the first linked person by source_position, created_at), with
--      two guards: the person must be linked to this property in this org,
--      and must not be marked do_not_contact. Choosing a do_not_contact
--      person would permanently DNC-lock the lead (properties_true_dnc_lock_guard,
--      a lock that cannot be cleared); that is a human's call, not an import's.
--      Training contacts are never chosen (guard_training_property).
--   2. fill_homeowner_from_links(property, org): NULL-only fill. Never rewires
--      a lead that already has a homeowner. Skips leads that are DNC-locked
--      (read-only by trigger), deleted, training, or disposed
--      wrong_number/bad_number/dnc/opted_out (not contactable; also avoids the
--      org-wide consent lock in serialize_property_safety_before_csv_consent).
--   3. upsert_dealmachine_property_contact / upsert_assigns_property_contact
--      call the fill after linking, so new imports land with a homeowner.
--   4. One-time backfill of existing leads, recorded in homeowner_link_backfill
--      so the rollback can undo exactly those rows and nothing else.
--
-- Prod shape on 2026-10-31: 14,933 leads with links and no homeowner
-- (9,856 DealMachine, 5,053 Assigns, 24 other). Of those: 16 DNC-locked and
-- 498 with an excluded disposition are skipped; 262 whose only candidate is
-- do_not_contact stay empty rather than being locked. ~14,150 rows change.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '180s';

create or replace function public.resolve_homeowner_from_links(
  p_property_id uuid,
  p_org_id uuid
) returns uuid
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
begin
  -- The person who most recently texted in, if they are linked to this lead.
  select m.contact_id into v_contact_id
  from public.messages m
  join public.contacts c on c.id = m.contact_id and c.org_id = p_org_id
  where m.property_id = p_property_id
    and m.org_id = p_org_id
    and m.direction = 'inbound'
    and m.channel = 'sms'
    and m.contact_id is not null
    and not coalesce(c.do_not_contact, false)
    and exists (
      select 1 from public.property_contacts pc
      where pc.property_id = p_property_id
        and pc.org_id = p_org_id
        and pc.contact_id = m.contact_id
    )
    and not public.is_training_target(null, m.contact_id)
  order by m.created_at desc
  limit 1;
  if v_contact_id is not null then
    return v_contact_id;
  end if;

  -- Otherwise the first linked person: vendor position, then link age.
  select pc.contact_id into v_contact_id
  from public.property_contacts pc
  join public.contacts c on c.id = pc.contact_id and c.org_id = pc.org_id
  where pc.property_id = p_property_id
    and pc.org_id = p_org_id
    and not coalesce(c.do_not_contact, false)
    and not public.is_training_target(null, pc.contact_id)
  order by pc.source_position asc, pc.created_at asc
  limit 1;
  return v_contact_id;
end;
$$;

create or replace function public.fill_homeowner_from_links(
  p_property_id uuid,
  p_org_id uuid
) returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
begin
  -- The candidate contact row is locked FOR SHARE before the property is
  -- written (contact, then property: the order contacts_propagate_true_dnc_lock
  -- uses). A do_not_contact flip committed after the resolver's snapshot but
  -- before our write is then re-checked on the row's newest version and the
  -- candidate is skipped; without the lock, properties_true_dnc_lock_guard
  -- would read the fresh flag and permanently DNC-lock the lead.
  update public.properties p
  set homeowner_contact_id = c.id
  from (
    select c.id
    from public.contacts c
    where c.id = public.resolve_homeowner_from_links(p_property_id, p_org_id)
      and c.org_id = p_org_id
      and not c.do_not_contact
    for share
  ) c
  where p.id = p_property_id
    and p.org_id = p_org_id
    and p.homeowner_contact_id is null
    and p.deleted_at is null
    and not p.is_dnc_locked
    and not p.is_training
    and (p.outreach_dispo is null
         or p.outreach_dispo not in ('wrong_number', 'bad_number', 'dnc', 'opted_out'))
  returning p.homeowner_contact_id into v_contact_id;
  return v_contact_id;
end;
$$;

revoke all on function public.resolve_homeowner_from_links(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fill_homeowner_from_links(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resolve_homeowner_from_links(uuid, uuid) to service_role;
grant execute on function public.fill_homeowner_from_links(uuid, uuid) to service_role;

-- Import functions: identical to 20261027222111 / 20260924180619 except for
-- the fill call before each return.
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

  -- Serialize a source person across replayed rows and properties.
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
    perform public.fill_homeowner_from_links(p_property_id, p_org_id);
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

  -- Match the existing name-only identity constraint before inserting. This
  -- mirrors the importer’s legacy name-only dedup path and avoids a duplicate
  -- key failure when the same unphoned person appears on another property.
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
  perform public.fill_homeowner_from_links(p_property_id, p_org_id);
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
    perform public.fill_homeowner_from_links(p_property_id, p_org_id);
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

  -- Match the existing name-only identity constraint before inserting. This
  -- mirrors the importer’s legacy name-only dedup path and avoids a duplicate
  -- key failure when the same unphoned person appears on another property.
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
  perform public.fill_homeowner_from_links(p_property_id, p_org_id);
  return v_contact_id;
end;
$$;

-- One-time backfill, recorded row by row so the rollback can undo exactly
-- these writes. Server-only; nothing reads it from the app.
--
-- Deliberately NO foreign key to properties: creating one takes
-- SHARE ROW EXCLUSIVE on public.properties for the rest of this transaction,
-- which would block every property write in every org while the ~14k-row
-- update below runs. The ledger is a plain audit table; a property deleted
-- later simply leaves an orphan row that the rollback's join ignores.
create table public.homeowner_link_backfill (
  property_id uuid primary key,
  org_id uuid not null,
  contact_id uuid not null,
  backfilled_at timestamptz not null default now()
);
alter table public.homeowner_link_backfill enable row level security;
revoke all on public.homeowner_link_backfill from public, anon, authenticated;
grant select on public.homeowner_link_backfill to service_role;

-- Resolve, write and record in ONE statement, so the ledger holds exactly the
-- rows this update wrote (RETURNING), never a candidate that was skipped.
-- Every eligibility predicate is on the update itself.
--
-- The candidate contact row is locked FOR SHARE (contact, then property, the
-- order contacts_propagate_true_dnc_lock uses) so a do_not_contact flip that
-- commits after this statement's snapshot is re-checked on the row's newest
-- version and the candidate is skipped. Without the lock the BEFORE UPDATE
-- trigger properties_true_dnc_lock_guard would read the fresh flag and
-- permanently DNC-lock the lead. A concurrent flip that arrives later waits
-- for this commit, then propagates the lock the normal way.
with candidate as (
  select p.id, p.org_id, c.id as contact_id
  from public.properties p
  cross join lateral (select public.resolve_homeowner_from_links(p.id, p.org_id) as contact_id) r
  join public.contacts c on c.id = r.contact_id and c.org_id = p.org_id
  where p.homeowner_contact_id is null
    and p.deleted_at is null
    and not p.is_dnc_locked
    and not p.is_training
    and (p.outreach_dispo is null
         or p.outreach_dispo not in ('wrong_number', 'bad_number', 'dnc', 'opted_out'))
    and not c.do_not_contact
  for share of c
),
written as (
  update public.properties p
  set homeowner_contact_id = c.contact_id
  from candidate c
  where p.id = c.id
    and p.org_id = c.org_id
    and p.homeowner_contact_id is null
    and p.deleted_at is null
    and not p.is_dnc_locked
    and not p.is_training
    and (p.outreach_dispo is null
         or p.outreach_dispo not in ('wrong_number', 'bad_number', 'dnc', 'opted_out'))
  returning p.id, p.org_id, p.homeowner_contact_id
)
insert into public.homeowner_link_backfill (property_id, org_id, contact_id)
select id, org_id, homeowner_contact_id from written;

commit;
