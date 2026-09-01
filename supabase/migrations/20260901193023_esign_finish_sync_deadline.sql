-- Persist the first embedded Finish synchronization attempt so Dropbox Sign
-- 404 propagation can follow its documented 60-minute callback window without
-- remaining retryable forever across new server-action invocations.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.esign_templates
  add column if not exists provider_sync_started_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.esign_templates'::regclass
      and conname = 'esign_templates_provider_sync_start_check'
  ) then
    alter table public.esign_templates
      add constraint esign_templates_provider_sync_start_check
      check (
        provider_sync_started_at is null
        or sign_template_id is not null
      ) not valid;
  end if;
end
$$;

comment on column public.esign_templates.provider_sync_started_at is
  'First Sandra synchronization attempt after embedded Finish. Dropbox Sign not_found reads are temporary for at most 60 minutes from this timestamp.';

commit;

-- Validation scans existing rows without retaining the ADD CONSTRAINT
-- transaction's ACCESS EXCLUSIVE lock for the duration of that scan.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.esign_templates
  validate constraint esign_templates_provider_sync_start_check;

commit;
