-- CSV import truthfulness and resume substrate.
-- Forward-only metadata; no existing business rows are rewritten.

alter table public.csv_imports
  add column if not exists dataset_sha256 text,
  add column if not exists dataset_version integer,
  add column if not exists dnc_rows integer not null default 0;

alter table public.csv_imports
  drop constraint if exists csv_imports_dataset_sha256_check;
alter table public.csv_imports
  add constraint csv_imports_dataset_sha256_check
  check (dataset_sha256 is null or dataset_sha256 ~ '^[a-f0-9]{64}$');

comment on column public.csv_imports.dataset_sha256 is
  'SHA-256 of the deterministic reviewed CSV bytes. The workflow refuses to ingest a storage object whose checksum differs.';
comment on column public.csv_imports.dataset_version is
  'Version of the deterministic reviewed-dataset serialization contract.';
comment on column public.csv_imports.dnc_rows is
  'Preflight DNC count conserved through review, confirmation, ingest, and results.';

alter table public.job_items
  add column if not exists source_row_index integer,
  add column if not exists compliance_locked boolean not null default false;

alter table public.job_items
  drop constraint if exists job_items_job_source_row_key;
alter table public.job_items
  add constraint job_items_job_source_row_key unique (job_id, source_row_index);

comment on column public.job_items.source_row_index is
  'Zero-based source CSV row index used as the idempotency checkpoint for workflow retries.';
comment on column public.job_items.compliance_locked is
  'True when the reviewed source row is DNC; optional services must exclude this job item server-side.';

alter table public.properties
  add column if not exists source_import_id uuid,
  add column if not exists source_imported_at timestamptz;

alter table public.properties
  drop constraint if exists properties_source_import_id_fkey;
alter table public.properties
  drop constraint if exists properties_source_import_org_fkey;

alter table public.csv_imports
  drop constraint if exists csv_imports_id_org_key;
alter table public.csv_imports
  add constraint csv_imports_id_org_key unique (id, org_id);

alter table public.properties
  add constraint properties_source_import_org_fkey
  foreign key (source_import_id, org_id)
  references public.csv_imports(id, org_id);

create index if not exists idx_properties_source_import
  on public.properties(source_import_id)
  where source_import_id is not null;

comment on column public.properties.source_import_id is
  'Most recent reviewed import that included this property, including a dedup match.';
comment on column public.properties.source_imported_at is
  'Timestamp of the most recent reviewed import that included this property.';

alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check check (status = any (array[
  'pending_approval'::text,
  'queued'::text,
  'processing'::text,
  'running'::text,
  'finalizing'::text,
  'completed'::text,
  'failed'::text,
  'partial'::text,
  'partially_completed'::text,
  'canceled'::text,
  'denied'::text
]));

drop index if exists public.idx_jobs_status;
create index idx_jobs_status on public.jobs(status)
  where status in ('queued', 'running', 'processing', 'finalizing');
