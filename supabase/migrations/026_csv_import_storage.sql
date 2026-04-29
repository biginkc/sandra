-- 026_csv_import_storage.sql
--
-- Wires the CSV importer to upload files into Supabase Storage instead of
-- shipping the parsed rows through the Server Action body. Required so
-- imports can run in a Workflow DevKit workflow whose steps download the
-- file from storage rather than carrying it in workflow state.
--
-- Two surfaces:
--   1. csv_imports.storage_path — pointer to the uploaded object
--   2. csv-imports bucket + RLS — authenticated users can upload, only
--      their own org can read
--
-- No data is migrated. Existing csv_imports rows have storage_path = NULL,
-- which is fine — they were created by the legacy after()-callback path
-- and don't need a storage object.

-- ---------- 1. csv_imports column -----------------------------------------

alter table public.csv_imports
  add column if not exists storage_path text null;

comment on column public.csv_imports.storage_path is 'Path within the csv-imports bucket where the source CSV was uploaded. Set when the import is started via the workflow runner; null for legacy imports that ran via the in-process after() callback.';

-- ---------- 2. csv-imports storage bucket ----------------------------------

-- Idempotent — re-running this migration is safe.
insert into storage.buckets (id, name, public)
values ('csv-imports', 'csv-imports', false)
on conflict (id) do nothing;

-- ---------- 3. RLS for the bucket ------------------------------------------
--
-- Matches the project-wide RLS posture (see migration 001): any
-- authenticated user can do anything on tenant tables. Single-tenant
-- system today; multi-tenancy lands later and will tighten this in lockstep
-- with the same change to public tables.
--
-- Service-role calls bypass RLS automatically — used by the workflow
-- runner (Vercel function) when it downloads the CSV to ingest.
--
-- Object key convention: csv-imports/{csv_import_id}.csv (no org folder
-- yet — the import row already carries org_id in the public.csv_imports
-- table; bucket key just has to be unique).

drop policy if exists "csv_imports_authenticated_all" on storage.objects;
create policy "csv_imports_authenticated_all"
  on storage.objects
  for all
  to authenticated
  using (bucket_id = 'csv-imports')
  with check (bucket_id = 'csv-imports');
