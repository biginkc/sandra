-- Harden property tag tenancy now that custom tags can be applied in bulk
-- from the prospects table. The application action checks org matching, but
-- the database should reject mismatched property/tag rows for every caller.

with duplicate_tags as (
  select id, canonical_id
  from (
    select
      id,
      first_value(id) over (
        partition by org_id, lower(name)
        order by (category = 'custom' and not system_managed) desc, created_at, id
      ) as canonical_id
    from public.tags
    where category = 'custom'
      and not system_managed
  ) ranked
  where id <> canonical_id
)
delete from public.property_tags duplicate_membership
using duplicate_tags
where duplicate_membership.tag_id = duplicate_tags.id
  and exists (
    select 1
    from public.property_tags canonical_membership
    where canonical_membership.property_id = duplicate_membership.property_id
      and canonical_membership.tag_id = duplicate_tags.canonical_id
  );

with duplicate_tags as (
  select id, canonical_id
  from (
    select
      id,
      first_value(id) over (
        partition by org_id, lower(name)
        order by (category = 'custom' and not system_managed) desc, created_at, id
      ) as canonical_id
    from public.tags
    where category = 'custom'
      and not system_managed
  ) ranked
  where id <> canonical_id
)
update public.property_tags
set tag_id = duplicate_tags.canonical_id
from duplicate_tags
where property_tags.tag_id = duplicate_tags.id;

with duplicate_tags as (
  select id, canonical_id
  from (
    select
      id,
      first_value(id) over (
        partition by org_id, lower(name)
        order by (category = 'custom' and not system_managed) desc, created_at, id
      ) as canonical_id
    from public.tags
    where category = 'custom'
      and not system_managed
  ) ranked
  where id <> canonical_id
)
delete from public.tags
using duplicate_tags
where tags.id = duplicate_tags.id;

create unique index if not exists idx_tags_org_lower_name_unique
  on public.tags (org_id, lower(name))
  where category = 'custom' and not system_managed;

create or replace function public.enforce_property_tag_org_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  property_org uuid;
  tag_org uuid;
begin
  select org_id into property_org
  from public.properties
  where id = new.property_id;

  select org_id into tag_org
  from public.tags
  where id = new.tag_id;

  if property_org is null then
    raise exception 'property_tags property_id % does not reference a property', new.property_id
      using errcode = '23503';
  end if;

  if tag_org is null then
    raise exception 'property_tags tag_id % does not reference a tag', new.tag_id
      using errcode = '23503';
  end if;

  if new.org_id <> property_org or new.org_id <> tag_org then
    raise exception 'property_tags org_id must match property and tag org_id'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists property_tags_org_integrity on public.property_tags;
create trigger property_tags_org_integrity
  before insert or update of org_id, property_id, tag_id
  on public.property_tags
  for each row
  execute function public.enforce_property_tag_org_integrity();

drop policy if exists property_tags_org_insert on public.property_tags;
drop policy if exists property_tags_org_update on public.property_tags;

create policy property_tags_org_insert
  on public.property_tags
  for insert
  to authenticated
  with check (
    org_id in (
      select org_id
      from public.memberships
      where user_id = auth.uid()
    )
    and exists (
      select 1
      from public.properties
      join public.tags on tags.id = property_tags.tag_id
      where properties.id = property_tags.property_id
        and properties.org_id = property_tags.org_id
        and tags.org_id = property_tags.org_id
    )
  );

create policy property_tags_org_update
  on public.property_tags
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.properties
      where properties.id = property_tags.property_id
        and properties.org_id in (
          select org_id
          from public.memberships
          where user_id = auth.uid()
        )
    )
  )
  with check (
    org_id in (
      select org_id
      from public.memberships
      where user_id = auth.uid()
    )
    and exists (
      select 1
      from public.properties
      join public.tags on tags.id = property_tags.tag_id
      where properties.id = property_tags.property_id
        and properties.org_id = property_tags.org_id
        and tags.org_id = property_tags.org_id
    )
  );
