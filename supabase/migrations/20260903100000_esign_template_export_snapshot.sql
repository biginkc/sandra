-- Durable, private snapshots of finalized Dropbox Sign templates.
-- This is intentionally separate from esign-staging: staging cleanup jobs must
-- never be able to remove an exported send artifact.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.esign_templates
  add column if not exists document_storage_bucket text,
  add column if not exists document_storage_path text,
  add column if not exists field_layout jsonb,
  add column if not exists layout_exported_at timestamptz,
  add column if not exists export_sha256 text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.esign_templates'::regclass
      and conname = 'esign_templates_document_snapshot_check'
  ) then
    alter table public.esign_templates
      add constraint esign_templates_document_snapshot_check check (
        (
          document_storage_bucket is null
          and document_storage_path is null
          and field_layout is null
          and layout_exported_at is null
          and export_sha256 is null
        )
        or (
          document_storage_bucket is not null
          and document_storage_bucket = 'esign-documents'
          and document_storage_path is not null
          and field_layout is not null
          and layout_exported_at is not null
          and export_sha256 is not null
          and document_storage_path ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
          and jsonb_typeof(field_layout) = 'object'
          and export_sha256 ~ '^[0-9a-f]{64}$'
        )
      );
  end if;
end
$$;

comment on column public.esign_templates.document_storage_bucket is
  'Private bucket holding the immutable PDF snapshot exported from Dropbox Sign.';
comment on column public.esign_templates.document_storage_path is
  'Opaque org-scoped path in esign-documents; staging cleanup never touches it.';
comment on column public.esign_templates.field_layout is
  'Versioned normalized Dropbox Sign field coordinates used by the future file-based sender.';
comment on column public.esign_templates.layout_exported_at is
  'Time the provider template layout and PDF snapshot were exported.';
comment on column public.esign_templates.export_sha256 is
  'Lowercase SHA-256 digest of the private PDF snapshot bytes.';

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
values (
  'esign-documents', 'esign-documents', false, 41943040,
  array['application/pdf']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "esign_documents_service_role_select" on storage.objects;
create policy "esign_documents_service_role_select"
  on storage.objects for select to service_role
  using (
    bucket_id = 'esign-documents'
    and name ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
  );

drop policy if exists "esign_documents_service_role_insert" on storage.objects;
create policy "esign_documents_service_role_insert"
  on storage.objects for insert to service_role
  with check (
    bucket_id = 'esign-documents'
    and name ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
  );

drop policy if exists "esign_documents_service_role_update" on storage.objects;
create policy "esign_documents_service_role_update"
  on storage.objects for update to service_role
  using (
    bucket_id = 'esign-documents'
    and name ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
  )
  with check (
    bucket_id = 'esign-documents'
    and name ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
  );

drop policy if exists "esign_documents_service_role_delete" on storage.objects;
create policy "esign_documents_service_role_delete"
  on storage.objects for delete to service_role
  using (
    bucket_id = 'esign-documents'
    and name ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
  );

commit;
