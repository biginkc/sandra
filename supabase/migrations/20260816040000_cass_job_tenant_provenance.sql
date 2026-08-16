-- CASS jobs authorize paid address lookups by their immutable tenant-owned
-- input. Authenticated operators may update ordinary job progress through
-- RLS, so freeze the fields that establish CASS provenance after insert.

create or replace function public.protect_cass_job_provenance()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.type = 'cass_dsf2_ncoa'
    and (
      new.org_id is distinct from old.org_id
      or new.type is distinct from old.type
      or new.input_params is distinct from old.input_params
      or new.parent_job_id is distinct from old.parent_job_id
      or new.related_import_id is distinct from old.related_import_id
    )
  then
    raise exception using
      errcode = 'P0001',
      message = 'CASS_JOB_PROVENANCE_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_protect_cass_provenance on public.jobs;
create trigger jobs_protect_cass_provenance
  before update on public.jobs
  for each row execute function public.protect_cass_job_provenance();
