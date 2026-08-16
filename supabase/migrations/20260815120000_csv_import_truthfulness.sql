-- CSV import truthfulness and resume substrate.
-- Forward-only schema hardening. Existing tenant sidecar/event rows are
-- reconciled to their contact's organization before composite FKs are added.

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

drop index if exists public.idx_properties_org_source_imported_at;
create index idx_properties_org_source_imported_at
  on public.properties(org_id, source_imported_at)
  where source_import_id is not null
    and source_imported_at is not null
    and deleted_at is null;

comment on column public.properties.source_import_id is
  'Most recent reviewed import that included this property, including a dedup match.';
comment on column public.properties.source_imported_at is
  'Timestamp of the most recent reviewed import that included this property.';

-- Legacy writers could silently accept the BMH default org_id on these
-- contact-owned tables. Reconcile existing rows, then make cross-tenant
-- sidecars and consent events structurally impossible.
update public.homeowner_details as details
set org_id = contacts.org_id
from public.contacts as contacts
where details.contact_id = contacts.id
  and details.org_id is distinct from contacts.org_id;

update public.agent_details as details
set org_id = contacts.org_id
from public.contacts as contacts
where details.contact_id = contacts.id
  and details.org_id is distinct from contacts.org_id;

update public.consent_events as events
set org_id = contacts.org_id
from public.contacts as contacts
where events.contact_id = contacts.id
  and events.org_id is distinct from contacts.org_id;

alter table public.homeowner_details
  drop constraint if exists homeowner_details_contact_org_fkey;
alter table public.homeowner_details
  add constraint homeowner_details_contact_org_fkey
  foreign key (contact_id, org_id)
  references public.contacts(id, org_id) on delete cascade;

alter table public.agent_details
  drop constraint if exists agent_details_contact_org_fkey;
alter table public.agent_details
  add constraint agent_details_contact_org_fkey
  foreign key (contact_id, org_id)
  references public.contacts(id, org_id) on delete cascade;

alter table public.consent_events
  drop constraint if exists consent_events_contact_org_fkey;
alter table public.consent_events
  add constraint consent_events_contact_org_fkey
  foreign key (contact_id, org_id)
  references public.contacts(id, org_id) on delete cascade;

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

-- The original dedup indexes were global even though every application
-- lookup is tenant-scoped. Rebuild the complete active contact/property
-- dedup set so two organizations can safely import the same identifiers.
drop index if exists public.contacts_phone_1_key;
create unique index contacts_phone_1_key
  on public.contacts (org_id, phone_1)
  where phone_1 is not null;

drop index if exists public.contacts_email_key;
create unique index contacts_email_key
  on public.contacts (org_id, lower(email))
  where email is not null and phone_1 is null;

drop index if exists public.contacts_person_name_key;
create unique index contacts_person_name_key
  on public.contacts (org_id, lower(last_name), lower(first_name))
  where contact_type = 'person'
    and phone_1 is null
    and email is null
    and last_name is not null
    and first_name is not null;

drop index if exists public.contacts_entity_name_key;
create unique index contacts_entity_name_key
  on public.contacts (org_id, lower(entity_name))
  where contact_type = 'entity'
    and phone_1 is null
    and email is null
    and entity_name is not null;

drop index if exists public.properties_fips_apn_key;
create unique index properties_fips_apn_key
  on public.properties (org_id, fips_code, apn_normalized)
  where fips_code is not null
    and apn_normalized is not null
    and deleted_at is null;

drop index if exists public.properties_regrid_key;
create unique index properties_regrid_key
  on public.properties (org_id, regrid_id)
  where regrid_id is not null
    and deleted_at is null;

drop index if exists public.properties_attom_key;
create unique index properties_attom_key
  on public.properties (org_id, attom_id)
  where attom_id is not null
    and deleted_at is null;

drop index if exists public.properties_zpid_key;
create unique index properties_zpid_key
  on public.properties (org_id, zpid)
  where zpid is not null
    and deleted_at is null;

drop index if exists public.properties_mls_number_key;
create unique index properties_mls_number_key
  on public.properties (org_id, mls_number)
  where mls_number is not null
    and deleted_at is null;

drop index if exists public.properties_address_normalized_key;
create unique index properties_address_normalized_key
  on public.properties (org_id, address_normalized)
  where address_normalized is not null
    and deleted_at is null;
