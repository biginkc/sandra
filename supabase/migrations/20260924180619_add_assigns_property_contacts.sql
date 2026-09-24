-- Assigns exports contain up to eight independently enriched contacts for a
-- property. The legacy homeowner_contact_id is intentionally retained as the
-- primary contact for existing screens; this relation preserves every source
-- contact and its vendor metadata without folding or dropping a block.
create table public.property_contacts (
  property_id uuid not null references public.properties(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  org_id uuid not null references public.organizations(id),
  relationship text not null default 'source_contact',
  source_position smallint not null,
  source_attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (property_id, relationship, source_position),
  constraint property_contacts_source_position_check
    check (source_position between 1 and 8)
);

create index property_contacts_org_property_idx
  on public.property_contacts (org_id, property_id);
create index property_contacts_org_contact_idx
  on public.property_contacts (org_id, contact_id);

alter table public.property_contacts enable row level security;

create policy property_contacts_org_select
  on public.property_contacts
  for select to authenticated
  using (
    org_id in (
      select membership.org_id
      from public.memberships membership
      where membership.user_id = (select auth.uid())
    )
  );

-- Import workers use the service role. Browser clients may read their org's
-- relation but cannot mutate it directly.
revoke insert, update, delete on public.property_contacts from anon, authenticated;
grant select on public.property_contacts to authenticated;
grant all on public.property_contacts to service_role;
