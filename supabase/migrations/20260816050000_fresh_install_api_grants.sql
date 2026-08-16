-- Restore the API privileges that hosted Supabase projects normally receive
-- from platform defaults. A database built only from this repository's SQL
-- migrations did not inherit those defaults, leaving authenticated and
-- service-role clients unable to use even RLS-protected tenant tables.
--
-- Grant authenticated access only on RLS-enabled tables. Policies remain the
-- authorization boundary, including service-only write policies. The service
-- role receives full table access and still remains an out-of-band secret.

-- job_items is authorized through its parent job, so its optional property
-- reference must belong to that same tenant. Lock both rows while checking so
-- a concurrent org transfer cannot invalidate the decision after the trigger.
create or replace function public.enforce_job_item_property_org()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  job_org_id uuid;
  property_org_id uuid;
begin
  select j.org_id into job_org_id
  from public.jobs j
  where j.id = new.job_id
  for key share;
  if not found then
    raise exception using errcode = '23503', message = 'JOB_NOT_FOUND';
  end if;

  if new.property_id is not null then
    select p.org_id into property_org_id
    from public.properties p
    where p.id = new.property_id
    for key share;
    if not found then
      raise exception using errcode = '23503', message = 'PROPERTY_NOT_FOUND';
    end if;
    if property_org_id is distinct from job_org_id then
      raise exception using errcode = '23514', message = 'JOB_ITEM_PROPERTY_ORG_MISMATCH';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_job_item_property_org on public.job_items;
create trigger enforce_job_item_property_org
before insert or update of job_id, property_id on public.job_items
for each row execute function public.enforce_job_item_property_org();

do $$
declare
  relation record;
begin
  for relation in
    select format('%I.%I', namespace.nspname, class.relname) as qualified_name
    from pg_class class
    join pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind in ('r', 'p')
      and class.relrowsecurity
  loop
    execute format(
      'grant select, insert, update, delete on table %s to authenticated',
      relation.qualified_name
    );
    execute format(
      'grant all privileges on table %s to service_role',
      relation.qualified_name
    );
  end loop;
end;
$$;

grant usage, select on all sequences in schema public
  to authenticated, service_role;

alter default privileges for role postgres in schema public
  grant all privileges on tables to service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to service_role;
