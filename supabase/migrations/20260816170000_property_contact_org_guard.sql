begin;

-- properties historically referenced contacts by globally unique id only.
-- A user who belongs to two organizations could therefore create a property
-- in one tenant pointing at a contact in the other. Application reads now
-- qualify the contact by the property's org, but tenant agreement belongs in
-- the schema as well. The referenced (id, org_id) unique key was added by the
-- appointments schema migration.
--
-- Keep the original single-column relationship names because application
-- PostgREST joins name them explicitly. Those constraints also ensure a
-- historical cross-tenant pointer is cleared if its referenced contact is
-- deleted. The additional composite constraints enforce tenant agreement on
-- every new/changed reference. NOT VALID avoids failing this forward migration
-- on historical cross-wires while still enforcing all future writes.
alter table public.properties
  drop constraint if exists properties_homeowner_contact_org_fkey;
alter table public.properties
  drop constraint if exists properties_homeowner_contact_id_fkey;
alter table public.properties
  add constraint properties_homeowner_contact_id_fkey
  foreign key (homeowner_contact_id)
  references public.contacts (id)
  on delete set null
  not valid;
alter table public.properties
  add constraint properties_homeowner_contact_org_fkey
  foreign key (homeowner_contact_id, org_id)
  references public.contacts (id, org_id)
  on delete set null (homeowner_contact_id)
  not valid;

alter table public.properties
  drop constraint if exists properties_agent_contact_org_fkey;
alter table public.properties
  drop constraint if exists properties_agent_contact_id_fkey;
alter table public.properties
  add constraint properties_agent_contact_id_fkey
  foreign key (agent_contact_id)
  references public.contacts (id)
  on delete set null
  not valid;
alter table public.properties
  add constraint properties_agent_contact_org_fkey
  foreign key (agent_contact_id, org_id)
  references public.contacts (id, org_id)
  on delete set null (agent_contact_id)
  not valid;

commit;
