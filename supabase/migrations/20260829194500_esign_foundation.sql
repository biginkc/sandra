-- Sandra eSign foundation: org-scoped Dropbox Sign credentials, templates,
-- requests, and private lead-file metadata. Dropbox Sign remains in test mode
-- for v1; provider credentials are encrypted with pgcrypto and can only be
-- decrypted through service-role RPCs.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if not exists (
    select 1 from pg_type where typnamespace = 'public'::regnamespace
      and typname = 'esign_request_status'
  ) then
    create type public.esign_request_status as enum (
      'awaiting', 'viewed', 'signed', 'declined', 'voided', 'error'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_type where typnamespace = 'public'::regnamespace
      and typname = 'esign_request_claim_outcome'
  ) then
    create type public.esign_request_claim_outcome as enum (
      'created', 'existing_same_payload', 'intent_conflict', 'blocked'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_type where typnamespace = 'public'::regnamespace
      and typname = 'esign_delivery_state'
  ) then
    create type public.esign_delivery_state as enum (
      'sending', 'sent', 'send_unknown', 'failed'
    );
  end if;
end
$$;

-- Keep eSign callbacks out of the generic provider lane used by skip trace.
alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_check;
alter table public.webhook_consumers
  add constraint webhook_consumers_type_check
  check (consumer_type = any (array[
    'lead', 'provider', 'jitter_writeback', 'closer_practice',
    'bmh_institute_course', 'esign_provider'
  ]));
alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_source_match_check;
alter table public.webhook_consumers
  add constraint webhook_consumers_type_source_match_check
  check (
    (consumer_type = 'lead' and default_source is not null)
    or
    (consumer_type in (
      'provider', 'jitter_writeback', 'closer_practice',
      'bmh_institute_course', 'esign_provider'
    ) and default_source is null)
  );
alter table public.webhook_consumers
  add constraint webhook_consumers_id_org_key unique (id, org_id);

create table public.org_esign_integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'dropbox_sign'
    check (provider = 'dropbox_sign'),
  api_key_encrypted bytea not null,
  api_key_last_four text not null check (char_length(api_key_last_four) = 4),
  client_id text not null check (btrim(client_id) <> ''),
  callback_consumer_id uuid not null unique,
  callback_verified_at timestamptz,
  sending_enabled boolean not null default false,
  test_mode boolean not null default true check (test_mode),
  connected_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  constraint org_esign_integrations_callback_consumer_org_fkey
    foreign key (callback_consumer_id, org_id)
    references public.webhook_consumers(id, org_id) on delete restrict,
  constraint org_esign_integrations_org_provider_key unique (org_id, provider),
  constraint org_esign_integrations_id_org_key unique (id, org_id),
  constraint org_esign_integrations_send_ready_check check (
    not sending_enabled or callback_verified_at is not null
  )
);

comment on table public.org_esign_integrations is
  'Org-scoped Dropbox Sign v1 connection. API keys are pgcrypto ciphertext; browser-visible reads exclude the ciphertext column.';
comment on column public.org_esign_integrations.callback_consumer_id is
  'Dedicated esign_provider callback consumer. It stores only the callback path secret hash.';

create or replace function public.validate_org_esign_callback_consumer()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.webhook_consumers consumer
    where consumer.id = new.callback_consumer_id
      and consumer.org_id = new.org_id
      and consumer.consumer_type = 'esign_provider'
      and consumer.enabled
      and consumer.revoked_at is null
  ) then
    raise exception 'org eSign integration requires an active dedicated eSign callback consumer'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_org_esign_callback_consumer()
  from public, anon, authenticated, service_role;
create trigger trg_org_esign_callback_consumer
  before insert or update of callback_consumer_id, org_id
  on public.org_esign_integrations
  for each row execute function public.validate_org_esign_callback_consumer();

create or replace function public.esign_signer_roles_are_valid(
  p_seller_role text,
  p_roles jsonb
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_typeof(p_roles) = 'array'
    and jsonb_array_length(p_roles) > 0
    and not exists (
      select 1
      from jsonb_array_elements(p_roles) with ordinality role(value, position)
      where jsonb_typeof(role.value) <> 'object'
        or btrim(coalesce(role.value ->> 'name', '')) = ''
        or not (role.value ? 'order')
        or (role.value ->> 'order') !~ '^[0-9]+$'
        or (role.value ->> 'order')::integer <> role.position - 1
    )
    and jsonb_array_length(p_roles) = (
      select count(distinct lower(role.value ->> 'name'))
      from jsonb_array_elements(p_roles) role(value)
    )
    and exists (
      select 1 from jsonb_array_elements(p_roles) role(value)
      where role.value ->> 'name' = p_seller_role
    );
$$;

create or replace function public.esign_merge_fields_are_valid(p_fields text[])
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select cardinality(p_fields) = 5
    and (
      select array_agg(field order by field)
      from unnest(p_fields) field
    ) = array[
      'closing_date', 'earnest_money', 'offer_price',
      'property_address', 'seller_name'
    ]::text[];
$$;

create table public.esign_template_staging_sources (
  id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  storage_bucket text not null default 'esign-staging'
    check (storage_bucket = 'esign-staging'),
  storage_path text not null,
  source_filename text not null check (
    source_filename = btrim(source_filename)
    and char_length(source_filename) between 1 and 255
    and source_filename !~ '[\\/[:cntrl:]]'
  ),
  source_size_bytes bigint not null check (
    source_size_bytes > 0 and source_size_bytes <= 41943040
  ),
  content_type text not null check (content_type = 'application/pdf'),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  cleanup_outcome text not null default 'pending'
    check (cleanup_outcome in ('pending', 'deleted', 'failed')),
  cleanup_attempted_at timestamptz,
  cleanup_error_code text check (
    cleanup_error_code is null
    or cleanup_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint esign_template_staging_sources_id_org_key unique (id, org_id),
  constraint esign_template_staging_sources_path_key
    unique (storage_bucket, storage_path),
  constraint esign_template_staging_sources_path_check check (
    storage_path = org_id::text || '/' || id::text || '.pdf'
  ),
  constraint esign_template_staging_sources_cleanup_check check (
    (cleanup_outcome = 'pending'
      and cleanup_attempted_at is null and cleanup_error_code is null)
    or (cleanup_outcome = 'deleted'
      and cleanup_attempted_at is not null and cleanup_error_code is null)
    or (cleanup_outcome = 'failed'
      and cleanup_attempted_at is not null and cleanup_error_code is not null)
  )
);

comment on table public.esign_template_staging_sources is
  'Service-attested metadata for private template PDFs. The server verifies object identity, bytes, MIME, PDF magic, and SHA-256 before inserting a row; browser metadata is never authoritative.';

create table public.esign_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (
    name = btrim(name)
    and char_length(name) between 1 and 160
    and name !~ '[[:cntrl:]]'
  ),
  document_type text not null check (btrim(document_type) <> ''),
  seller_role text not null check (btrim(seller_role) <> ''),
  signer_roles jsonb not null check (
    public.esign_signer_roles_are_valid(seller_role, signer_roles)
  ),
  merge_field_names text[] not null check (
    public.esign_merge_fields_are_valid(merge_field_names)
  ),
  sign_template_id text,
  staging_source_id uuid,
  source_filename text check (
    source_filename is null
    or (
      source_filename = btrim(source_filename)
      and char_length(source_filename) between 1 and 255
      and source_filename !~ '[\\/[:cntrl:]]'
    )
  ),
  source_size_bytes bigint check (
    source_size_bytes is null
    or (source_size_bytes > 0 and source_size_bytes <= 41943040)
  ),
  source_content_type text check (
    source_content_type is null or source_content_type = 'application/pdf'
  ),
  source_sha256 text check (
    source_sha256 is null or source_sha256 ~ '^[a-f0-9]{64}$'
  ),
  staging_path text,
  staging_deleted_at timestamptz,
  finalized_at timestamptz,
  lifecycle_state text not null default 'preparing'
    check (lifecycle_state in (
      'preparing', 'editing', 'finalized', 'abandoned', 'deleted', 'error'
    )),
  duplicate_of_template_id uuid,
  preparation_error_code text check (
    preparation_error_code is null
    or preparation_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  abandoned_by uuid references auth.users(id),
  abandoned_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  deleted_by uuid references auth.users(id),
  deleted_at timestamptz,
  constraint esign_templates_id_org_key unique (id, org_id),
  constraint esign_templates_staging_source_org_fkey
    foreign key (staging_source_id, org_id)
    references public.esign_template_staging_sources(id, org_id),
  constraint esign_templates_duplicate_org_fkey
    foreign key (duplicate_of_template_id, org_id)
    references public.esign_templates(id, org_id),
  constraint esign_templates_opaque_staging_path_check check (
    staging_path is null
    or staging_path = org_id::text || '/' || staging_source_id::text || '.pdf'
  ),
  constraint esign_templates_source_snapshot_check check (
    (
      staging_source_id is not null
      and source_filename is not null
      and source_size_bytes is not null
      and source_content_type = 'application/pdf'
      and source_sha256 is not null
      and staging_path is not null
    )
    or (
      staging_source_id is null
      and duplicate_of_template_id is not null
      and staging_path is null
    )
  ),
  constraint esign_templates_finalized_provider_check check (
    finalized_at is null or sign_template_id is not null
  ),
  constraint esign_templates_staging_cleanup_check check (
    staging_deleted_at is null
    or finalized_at is not null
    or abandoned_at is not null
    or deleted_at is not null
  ),
  constraint esign_templates_lifecycle_check check (
    (lifecycle_state = 'preparing'
      and finalized_at is null and deleted_at is null and abandoned_at is null)
    or (lifecycle_state = 'editing'
      and sign_template_id is not null
      and finalized_at is null and deleted_at is null and abandoned_at is null)
    or (lifecycle_state = 'finalized'
      and sign_template_id is not null and finalized_at is not null
      and deleted_at is null and abandoned_at is null)
    or (lifecycle_state = 'abandoned'
      and finalized_at is null and abandoned_at is not null
      and abandoned_by is not null and deleted_at is null)
    or (lifecycle_state = 'deleted'
      and deleted_at is not null and deleted_by is not null)
    or (lifecycle_state = 'error'
      and finalized_at is null and deleted_at is null
      and preparation_error_code is not null)
  ),
  constraint esign_templates_delete_audit_check check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
  ),
  constraint esign_templates_abandon_audit_check check (
    (abandoned_at is null and abandoned_by is null)
    or (abandoned_at is not null and abandoned_by is not null)
  )
);

comment on table public.esign_templates is
  'Sandra metadata for Dropbox Sign templates. Drafts have finalized_at NULL and are hidden; deletion is soft so historical requests remain attributable.';
comment on column public.esign_templates.staging_path is
  'Opaque object path in the private esign-staging bucket. Never a public URL.';
comment on column public.esign_templates.staging_deleted_at is
  'Audit timestamp for private staged-file cleanup after finalization or soft deletion.';

create table public.esign_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  template_id uuid not null,
  signer_snapshot jsonb not null check (jsonb_typeof(signer_snapshot) = 'array'),
  merge_value_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(merge_value_snapshot) = 'object'),
  status public.esign_request_status not null default 'awaiting',
  delivery_state public.esign_delivery_state not null default 'sending',
  test_mode boolean not null default true check (test_mode),
  sign_request_id text,
  details_url text,
  send_intent_id uuid not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  retry_of_request_id uuid,
  sent_at timestamptz,
  completed_at timestamptz,
  void_requested_at timestamptz,
  void_claim_token uuid,
  void_claimed_at timestamptz,
  error_message text check (
    error_message is null or error_message ~ '^[A-Z][A-Z0-9_]{0,127}$'
  ),
  signed_pdf_path text,
  provider_event_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  constraint esign_requests_id_org_key unique (id, org_id),
  constraint esign_requests_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id),
  constraint esign_requests_template_org_fkey
    foreign key (template_id, org_id)
    references public.esign_templates(id, org_id),
  constraint esign_requests_retry_org_fkey
    foreign key (retry_of_request_id, org_id)
    references public.esign_requests(id, org_id),
  constraint esign_requests_error_check check (
    (status = 'error' and error_message is not null)
    or status <> 'error'
  ),
  constraint esign_requests_delivery_check check (
    (delivery_state = 'sending' and sign_request_id is null and sent_at is null)
    or (delivery_state = 'sent' and sign_request_id is not null and sent_at is not null)
    or (delivery_state = 'send_unknown')
    or (delivery_state = 'failed' and error_message is not null)
  ),
  constraint esign_requests_lifecycle_check check (
    (status in ('awaiting', 'error'))
    or (status in ('viewed', 'signed', 'declined', 'voided')
      and sign_request_id is not null)
  ),
  constraint esign_requests_terminal_time_check check (
    (status in ('signed', 'declined', 'voided', 'error') and completed_at is not null)
    or (status not in ('signed', 'declined', 'voided', 'error'))
  ),
  constraint esign_requests_void_time_check check (
    void_requested_at is null
    or completed_at is null
    or void_requested_at <= completed_at
  ),
  constraint esign_requests_void_claim_check check (
    (void_claim_token is null and void_claimed_at is null)
    or (void_claim_token is not null and void_claimed_at is not null)
  ),
  constraint esign_requests_signed_pdf_check check (
    signed_pdf_path is null or status = 'signed'
  )
);

comment on table public.esign_requests is
  'Local eSign request ledger. id is Sandra identity; sign_request_id is the distinct Dropbox Sign signature_request_id.';
comment on column public.esign_requests.created_at is
  'Immutable local creation time used with id DESC for deterministic latest-per-property ordering. Provider callbacks only update updated_at/provider_event_at.';

create table public.esign_request_signers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid not null,
  role_name text not null check (btrim(role_name) <> ''),
  signer_order integer not null check (signer_order >= 0),
  signer_name text not null check (btrim(signer_name) <> ''),
  signer_email text not null check (btrim(signer_email) <> ''),
  provider_signature_id text,
  status text not null default 'awaiting'
    check (status in ('awaiting', 'viewed', 'signed', 'declined', 'error')),
  viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  last_reminded_at timestamptz,
  reminder_claim_token uuid,
  reminder_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint esign_request_signers_request_org_fkey
    foreign key (request_id, org_id)
    references public.esign_requests(id, org_id) on delete cascade,
  constraint esign_request_signers_request_role_key unique (request_id, role_name),
  constraint esign_request_signers_request_order_key unique (request_id, signer_order),
  constraint esign_request_signers_provider_id_key unique (org_id, provider_signature_id),
  constraint esign_request_signers_status_time_check check (
    (status <> 'viewed' or viewed_at is not null)
    and (status <> 'signed' or signed_at is not null)
    and (status <> 'declined' or declined_at is not null)
  ),
  constraint esign_request_signers_reminder_claim_check check (
    (reminder_claim_token is null and reminder_claimed_at is null)
    or (reminder_claim_token is not null and reminder_claimed_at is not null)
  )
);

create table public.lead_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  source_request_id uuid not null,
  file_name text not null check (btrim(file_name) <> ''),
  content_type text not null default 'application/pdf'
    check (content_type = 'application/pdf'),
  size_bytes bigint not null check (
    size_bytes > 0 and size_bytes <= 41943040
  ),
  storage_bucket text not null default 'lead-files'
    check (storage_bucket = 'lead-files'),
  storage_path text not null check (btrim(storage_path) <> ''),
  source text not null default 'esign_signed_pdf'
    check (source = 'esign_signed_pdf'),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint lead_files_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id),
  constraint lead_files_request_org_fkey
    foreign key (source_request_id, org_id)
    references public.esign_requests(id, org_id),
  constraint lead_files_opaque_name_check check (
    file_name = 'signed-contract-'
      || left(source_request_id::text, 8) || '.pdf'
  ),
  constraint lead_files_opaque_path_check check (
    cardinality(string_to_array(storage_path, '/')) = 5
    and split_part(storage_path, '/', 1) = org_id::text
    and split_part(storage_path, '/', 2) ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and split_part(storage_path, '/', 3) = 'esign'
    and split_part(storage_path, '/', 4) = source_request_id::text
    and split_part(storage_path, '/', 5) = 'signed.pdf'
  ),
  constraint lead_files_storage_path_key unique (storage_bucket, storage_path)
);

comment on table public.lead_files is
  'Private lead artifact metadata. Signed PDFs live in the private lead-files Storage bucket.';

create unique index idx_esign_templates_provider_id
  on public.esign_templates (org_id, sign_template_id)
  where sign_template_id is not null;
create unique index idx_esign_templates_staging_source
  on public.esign_templates (org_id, staging_source_id)
  where staging_source_id is not null;
create index idx_esign_templates_active
  on public.esign_templates (org_id, updated_at desc, id desc)
  where deleted_at is null and finalized_at is not null;

create view public.available_esign_templates
with (security_invoker = true)
as
select *
from public.esign_templates
where deleted_at is null and finalized_at is not null;

create unique index idx_esign_requests_provider_id
  on public.esign_requests (org_id, sign_request_id)
  where sign_request_id is not null;
create unique index idx_esign_requests_send_intent
  on public.esign_requests (org_id, send_intent_id);
create index idx_esign_requests_latest_property
  on public.esign_requests (org_id, property_id, created_at desc, id desc);
create index idx_esign_requests_status
  on public.esign_requests (org_id, status, created_at desc, id desc);
create index idx_esign_requests_delivery
  on public.esign_requests (org_id, delivery_state, created_at desc, id desc);
create index idx_esign_request_signers_request
  on public.esign_request_signers (org_id, request_id, signer_order);
create index idx_esign_request_signers_reminders
  on public.esign_request_signers (org_id, status, last_reminded_at)
  where status in ('awaiting', 'viewed');

create unique index idx_lead_files_esign_request
  on public.lead_files (org_id, source_request_id)
  where source_request_id is not null and source = 'esign_signed_pdf';
create index idx_lead_files_property
  on public.lead_files (org_id, property_id, created_at desc, id desc);

create or replace function public.esign_is_active_org_owner(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships membership
    where membership.org_id = p_org_id
      and membership.user_id = auth.uid()
      and membership.role = 'owner'
      and membership.access_status = 'active'
      and membership.deletion_prepared_at is null
      and (membership.access_expires_at is null or membership.access_expires_at > now())
  );
$$;

revoke all on function public.esign_is_active_org_owner(uuid)
  from public, anon, service_role;
grant execute on function public.esign_is_active_org_owner(uuid)
  to authenticated;

create or replace function public.reject_esign_request_snapshot_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.created_at is distinct from old.created_at
     or new.org_id is distinct from old.org_id
     or new.template_id is distinct from old.template_id
     or new.signer_snapshot is distinct from old.signer_snapshot
     or new.merge_value_snapshot is distinct from old.merge_value_snapshot
     or new.test_mode is distinct from old.test_mode
     or new.send_intent_id is distinct from old.send_intent_id
     or new.payload_hash is distinct from old.payload_hash
     or new.retry_of_request_id is distinct from old.retry_of_request_id then
    raise exception 'esign request identity and send snapshots are immutable'
      using errcode = '22000';
  end if;
  return new;
end;
$$;

create or replace function public.validate_esign_request_retry()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_previous public.esign_requests%rowtype;
begin
  if new.retry_of_request_id is null then
    return new;
  end if;
  if new.retry_of_request_id = new.id then
    raise exception 'an eSign request cannot retry itself' using errcode = '23514';
  end if;
  select * into v_previous
  from public.esign_requests
  where id = new.retry_of_request_id and org_id = new.org_id;
  if not found
     or v_previous.property_id <> new.property_id
     or v_previous.template_id <> new.template_id then
    raise exception 'retry must reference the same org, property, and template'
      using errcode = '23514';
  end if;
  if v_previous.delivery_state <> 'failed' then
    raise exception 'only a failed delivery can be retried'
      using errcode = '23514';
  end if;
  if new.created_at <= v_previous.created_at then
    raise exception 'retry creation time must be newer than the failed request'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.reject_esign_request_snapshot_change()
  from public, anon, authenticated, service_role;

create trigger trg_esign_requests_created_at_immutable
  before update on public.esign_requests
  for each row execute function public.reject_esign_request_snapshot_change();
create trigger trg_esign_requests_retry_valid
  before insert or update on public.esign_requests
  for each row execute function public.validate_esign_request_retry();

alter table public.org_esign_integrations enable row level security;
alter table public.esign_template_staging_sources enable row level security;
alter table public.esign_templates enable row level security;
alter table public.esign_requests enable row level security;
alter table public.esign_request_signers enable row level security;
alter table public.lead_files enable row level security;

create policy org_esign_integrations_org_select
  on public.org_esign_integrations for select to authenticated
  using (public.hugo_has_active_org_access(org_id));
create policy org_esign_integrations_owner_insert
  on public.org_esign_integrations for insert to authenticated
  with check (public.esign_is_active_org_owner(org_id));
create policy org_esign_integrations_owner_update
  on public.org_esign_integrations for update to authenticated
  using (public.esign_is_active_org_owner(org_id))
  with check (public.esign_is_active_org_owner(org_id));
create policy org_esign_integrations_owner_delete
  on public.org_esign_integrations for delete to authenticated
  using (public.esign_is_active_org_owner(org_id));

create policy esign_templates_org_select
  on public.esign_templates for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and (
      public.esign_is_active_org_owner(org_id)
      or (deleted_at is null and finalized_at is not null)
    )
  );
create policy esign_requests_org_select
  on public.esign_requests for select to authenticated
  using (public.hugo_has_active_org_access(org_id));
create policy esign_request_signers_org_select
  on public.esign_request_signers for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

create policy lead_files_org_select
  on public.lead_files for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

revoke all on table public.org_esign_integrations
  from public, anon, authenticated, service_role;
grant select (
  id, org_id, provider, api_key_last_four, client_id, sending_enabled,
  test_mode, callback_verified_at, connected_by, created_at, updated_by, updated_at
) on public.org_esign_integrations to authenticated;
grant all on table public.org_esign_integrations to service_role;

revoke all on table public.esign_templates
  from public, anon, authenticated, service_role;
grant select on table public.esign_templates to authenticated;
grant all on table public.esign_templates to service_role;
revoke all on table public.esign_template_staging_sources
  from public, anon, authenticated, service_role;
grant all on table public.esign_template_staging_sources to service_role;
revoke all on table public.available_esign_templates
  from public, anon, authenticated, service_role;
grant select on table public.available_esign_templates to authenticated;
grant select on table public.available_esign_templates to service_role;

create or replace function public.esign_require_active_owner(
  p_org_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships membership
    where membership.org_id = p_org_id
      and membership.user_id = p_actor_id
      and membership.role = 'owner'
      and membership.access_status = 'active'
      and membership.deletion_prepared_at is null
      and (membership.access_expires_at is null or membership.access_expires_at > now())
  ) then
    raise exception 'active organization owner required' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.record_verified_esign_template_source(
  p_org_id uuid, p_source_id uuid, p_storage_path text,
  p_source_filename text, p_source_size_bytes bigint, p_content_type text,
  p_source_sha256 text, p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_existing public.esign_template_staging_sources%rowtype;
begin
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if p_storage_path <> p_org_id::text || '/' || p_source_id::text || '.pdf'
     or p_content_type <> 'application/pdf'
     or p_source_size_bytes <= 0 or p_source_size_bytes > 41943040
     or p_source_sha256 !~ '^[a-f0-9]{64}$'
     or p_source_filename <> btrim(p_source_filename)
     or char_length(p_source_filename) not between 1 and 255
     or p_source_filename ~ '[\\/[:cntrl:]]' then
    raise exception 'verified template source metadata is invalid'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from storage.objects object
    where object.bucket_id = 'esign-staging'
      and object.name = p_storage_path
      and nullif(object.metadata ->> 'size', '')::bigint = p_source_size_bytes
      and coalesce(object.metadata ->> 'mimetype', object.metadata ->> 'contentType')
        = p_content_type
  ) then
    raise exception 'verified template source object does not match storage'
      using errcode = '23514';
  end if;
  select * into v_existing
  from public.esign_template_staging_sources source
  where source.id = p_source_id and source.org_id = p_org_id
  for update;
  if found then
    if v_existing.storage_path = p_storage_path
       and v_existing.source_filename = p_source_filename
       and v_existing.source_size_bytes = p_source_size_bytes
       and v_existing.content_type = p_content_type
       and v_existing.source_sha256 = p_source_sha256 then
      return v_existing.id;
    end if;
    raise exception 'verified template source metadata conflicts with the existing source'
      using errcode = '23505';
  end if;
  insert into public.esign_template_staging_sources (
    id, org_id, storage_path, source_filename, source_size_bytes,
    content_type, source_sha256, created_by
  ) values (
    p_source_id, p_org_id, p_storage_path, p_source_filename,
    p_source_size_bytes, p_content_type, p_source_sha256, p_actor_id
  );
  return p_source_id;
end;
$$;

create or replace function public.create_esign_template_draft(
  p_org_id uuid, p_source_id uuid, p_name text, p_document_type text,
  p_seller_role text, p_signer_roles jsonb, p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
  v_source public.esign_template_staging_sources%rowtype;
begin
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_source
  from public.esign_template_staging_sources source
  where source.id = p_source_id and source.org_id = p_org_id
    and source.cleanup_outcome = 'pending'
  for update;
  if not found then
    raise exception 'verified template source not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.esign_templates template
    where template.org_id = p_org_id and template.staging_source_id = p_source_id
  ) then
    raise exception 'verified template source is already attached'
      using errcode = '23505';
  end if;
  insert into public.esign_templates (
    id, org_id, name, document_type, seller_role, signer_roles,
    merge_field_names, staging_source_id, source_filename,
    source_size_bytes, source_content_type, source_sha256, staging_path,
    lifecycle_state, created_by, updated_by
  ) values (
    v_id, p_org_id, p_name, p_document_type, p_seller_role, p_signer_roles,
    array['seller_name','property_address','offer_price','closing_date','earnest_money']::text[],
    v_source.id, v_source.source_filename, v_source.source_size_bytes,
    v_source.content_type, v_source.source_sha256, v_source.storage_path,
    'preparing', p_actor_id, p_actor_id
  );
  return v_id;
end;
$$;

create or replace function public.create_esign_template_duplicate_draft(
  p_org_id uuid, p_source_template_id uuid, p_name text, p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
  v_source public.esign_templates%rowtype;
begin
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_source from public.esign_templates template
  where template.id = p_source_template_id and template.org_id = p_org_id
    and template.lifecycle_state = 'finalized' and template.deleted_at is null
  for update;
  if not found then
    raise exception 'source eSign template not found' using errcode = 'P0002';
  end if;
  insert into public.esign_templates (
    id, org_id, name, document_type, seller_role, signer_roles,
    merge_field_names, source_filename, source_size_bytes,
    source_content_type, source_sha256, lifecycle_state,
    duplicate_of_template_id, created_by, updated_by
  ) values (
    v_id, p_org_id, p_name, v_source.document_type, v_source.seller_role,
    v_source.signer_roles, v_source.merge_field_names, v_source.source_filename,
    v_source.source_size_bytes, v_source.source_content_type,
    v_source.source_sha256, 'preparing', v_source.id, p_actor_id, p_actor_id
  );
  return v_id;
end;
$$;

create or replace function public.attach_esign_template_provider_id(
  p_org_id uuid, p_template_id uuid, p_provider_template_id text, p_actor_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template public.esign_templates%rowtype;
begin
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if btrim(coalesce(p_provider_template_id, '')) = '' then
    raise exception 'provider template ID is required' using errcode = '22023';
  end if;
  select * into v_template from public.esign_templates template
  where template.id = p_template_id and template.org_id = p_org_id
  for update;
  if not found or v_template.deleted_at is not null
     or v_template.finalized_at is not null
     or v_template.lifecycle_state not in ('preparing', 'editing') then
    raise exception 'eSign template draft not found' using errcode = 'P0002';
  end if;
  if v_template.staging_source_id is not null and not exists (
    select 1 from public.esign_template_staging_sources source
    where source.id = v_template.staging_source_id and source.org_id = p_org_id
      and source.cleanup_outcome = 'pending'
  ) then
    raise exception 'verified template source is unavailable' using errcode = '23514';
  end if;
  if v_template.staging_source_id is null
     and v_template.duplicate_of_template_id is null then
    raise exception 'verified template source is required' using errcode = '23514';
  end if;
  if v_template.sign_template_id is not null then
    if v_template.sign_template_id = p_provider_template_id then
      return 'already_attached';
    end if;
    raise exception 'provider template ID conflicts with the attached draft'
      using errcode = '23505';
  end if;
  update public.esign_templates set
    sign_template_id = p_provider_template_id, lifecycle_state = 'editing',
    preparation_error_code = null, updated_by = p_actor_id, updated_at = now()
  where id = p_template_id and org_id = p_org_id;
  return 'attached';
end;
$$;

create or replace function public.finalize_esign_template(
  p_org_id uuid, p_template_id uuid, p_provider_template_id text,
  p_seller_role text, p_provider_signer_roles jsonb,
  p_provider_merge_field_names text[], p_actor_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template public.esign_templates%rowtype;
begin
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if btrim(coalesce(p_provider_template_id, '')) = ''
     or not public.esign_signer_roles_are_valid(p_seller_role, p_provider_signer_roles)
     or not public.esign_merge_fields_are_valid(p_provider_merge_field_names) then
    raise exception 'provider-reconciled template contract is invalid'
      using errcode = '23514';
  end if;
  select * into v_template from public.esign_templates template
  where template.id = p_template_id and template.org_id = p_org_id
  for update;
  if not found or v_template.deleted_at is not null then
    raise exception 'eSign template draft not found' using errcode = 'P0002';
  end if;
  if v_template.finalized_at is not null then
    if v_template.lifecycle_state = 'finalized'
       and v_template.sign_template_id = p_provider_template_id
       and v_template.seller_role = p_seller_role
       and v_template.signer_roles = p_provider_signer_roles
       and public.esign_merge_fields_are_valid(v_template.merge_field_names) then
      return 'already_finalized';
    end if;
    raise exception 'finalized eSign template state conflicts with provider state'
      using errcode = '23505';
  end if;
  if v_template.lifecycle_state <> 'editing'
     or v_template.sign_template_id is distinct from p_provider_template_id then
    raise exception 'eSign template draft changed before finalization'
      using errcode = '40001';
  end if;
  update public.esign_templates set
    seller_role = p_seller_role, signer_roles = p_provider_signer_roles,
    merge_field_names = p_provider_merge_field_names, finalized_at = now(),
    lifecycle_state = 'finalized', updated_by = p_actor_id, updated_at = now()
  where id = p_template_id and org_id = p_org_id
    and finalized_at is null and deleted_at is null
    and lifecycle_state = 'editing' and sign_template_id = p_provider_template_id;
  if not found then
    raise exception 'eSign template draft changed before finalization'
      using errcode = '40001';
  end if;
  return 'finalized';
end;
$$;

create or replace function public.abandon_esign_template_draft(
  p_org_id uuid, p_template_id uuid, p_actor_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_template public.esign_templates%rowtype;
begin
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_template from public.esign_templates template
  where template.id = p_template_id and template.org_id = p_org_id for update;
  if not found then raise exception 'eSign template draft not found' using errcode = 'P0002'; end if;
  if v_template.lifecycle_state = 'abandoned' then return 'already_abandoned'; end if;
  if v_template.finalized_at is not null or v_template.deleted_at is not null then
    raise exception 'only an unfinished eSign template draft can be abandoned'
      using errcode = '55000';
  end if;
  update public.esign_templates set lifecycle_state = 'abandoned',
    abandoned_by = p_actor_id, abandoned_at = now(), updated_by = p_actor_id,
    updated_at = now() where id = p_template_id and org_id = p_org_id;
  return 'abandoned';
end;
$$;

create or replace function public.record_esign_template_source_cleanup(
  p_org_id uuid, p_template_id uuid, p_storage_path text,
  p_outcome text, p_error_code text, p_actor_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare v_template public.esign_templates%rowtype;
begin
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if p_outcome not in ('deleted', 'failed')
     or (p_outcome = 'deleted' and p_error_code is not null)
     or (p_outcome = 'failed' and coalesce(p_error_code, '') !~ '^[A-Z][A-Z0-9_]{0,63}$') then
    raise exception 'invalid template source cleanup outcome' using errcode = '22023';
  end if;
  select * into v_template from public.esign_templates template
  where template.id = p_template_id and template.org_id = p_org_id for update;
  if not found or v_template.staging_source_id is null
     or v_template.staging_path is distinct from p_storage_path then
    raise exception 'template source cleanup target does not match' using errcode = '23514';
  end if;
  if v_template.finalized_at is null and v_template.abandoned_at is null
     and v_template.deleted_at is null then
    raise exception 'unfinished template source cannot be cleaned up' using errcode = '55000';
  end if;
  if p_outcome = 'deleted' and exists (
    select 1 from storage.objects object
    where object.bucket_id = 'esign-staging' and object.name = p_storage_path
  ) then
    raise exception 'template source object still exists' using errcode = '23514';
  end if;
  update public.esign_template_staging_sources set cleanup_outcome = p_outcome,
    cleanup_attempted_at = now(), cleanup_error_code = p_error_code
  where id = v_template.staging_source_id and org_id = p_org_id;
  update public.esign_templates set
    staging_deleted_at = case when p_outcome = 'deleted' then now() else null end,
    updated_by = p_actor_id, updated_at = now()
  where id = p_template_id and org_id = p_org_id;
  return p_outcome;
end;
$$;

create or replace function public.soft_delete_esign_template(
  p_org_id uuid, p_template_id uuid, p_confirm_recent_sends boolean,
  p_actor_id uuid
)
returns table (outcome text, recent_send_count bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template public.esign_templates%rowtype;
  v_recent bigint;
begin
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_template from public.esign_templates template
  where template.id = p_template_id and template.org_id = p_org_id for update;
  if not found then raise exception 'eSign template not found' using errcode = 'P0002'; end if;
  select count(*) into v_recent from public.esign_requests request
  where request.org_id = p_org_id and request.template_id = p_template_id
    and request.created_at >= now() - interval '30 days';
  if v_template.deleted_at is not null then
    return query select 'already_deleted'::text, v_recent; return;
  end if;
  if v_recent > 0 and not p_confirm_recent_sends then
    return query select 'needs_confirmation'::text, v_recent; return;
  end if;
  update public.esign_templates set deleted_at = now(), deleted_by = p_actor_id,
    lifecycle_state = 'deleted', updated_at = now(), updated_by = p_actor_id
  where id = p_template_id and org_id = p_org_id and deleted_at is null;
  return query select 'deleted'::text, v_recent;
end;
$$;

revoke all on function public.esign_require_active_owner(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.esign_require_active_owner(uuid, uuid) to service_role;
revoke all on function public.record_verified_esign_template_source(
  uuid, uuid, text, text, bigint, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.record_verified_esign_template_source(
  uuid, uuid, text, text, bigint, text, text, uuid
) to service_role;
revoke all on function public.create_esign_template_draft(
  uuid, uuid, text, text, text, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.create_esign_template_draft(
  uuid, uuid, text, text, text, jsonb, uuid
) to service_role;
revoke all on function public.create_esign_template_duplicate_draft(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_esign_template_duplicate_draft(uuid, uuid, text, uuid)
  to service_role;
revoke all on function public.attach_esign_template_provider_id(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.attach_esign_template_provider_id(uuid, uuid, text, uuid)
  to service_role;
revoke all on function public.finalize_esign_template(
  uuid, uuid, text, text, jsonb, text[], uuid
) from public, anon, authenticated;
grant execute on function public.finalize_esign_template(
  uuid, uuid, text, text, jsonb, text[], uuid
) to service_role;
revoke all on function public.abandon_esign_template_draft(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.abandon_esign_template_draft(uuid, uuid, uuid)
  to service_role;
revoke all on function public.record_esign_template_source_cleanup(
  uuid, uuid, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.record_esign_template_source_cleanup(
  uuid, uuid, text, text, text, uuid
) to service_role;
revoke all on function public.soft_delete_esign_template(uuid, uuid, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.soft_delete_esign_template(uuid, uuid, boolean, uuid)
  to service_role;

revoke all on table public.esign_requests
  from public, anon, authenticated, service_role;
grant select on table public.esign_requests to authenticated;
grant all on table public.esign_requests to service_role;

revoke all on table public.esign_request_signers
  from public, anon, authenticated, service_role;
grant select on table public.esign_request_signers to authenticated;
grant all on table public.esign_request_signers to service_role;

create or replace function public.get_latest_esign_requests_for_properties(
  p_org_id uuid,
  p_property_ids uuid[]
)
returns table (
  org_id uuid,
  property_id uuid,
  id uuid,
  created_at timestamptz,
  status public.esign_request_status
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if cardinality(p_property_ids) is null
     or cardinality(p_property_ids) < 1
     or cardinality(p_property_ids) > 50
     or array_position(p_property_ids, null) is not null
     or (
       select count(distinct requested_id)
       from unnest(p_property_ids) requested_id
     ) <> cardinality(p_property_ids) then
    raise exception 'property IDs must contain 1 to 50 distinct UUIDs'
      using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.hugo_has_active_org_access(p_org_id) then
    raise exception 'active organization membership required'
      using errcode = '42501';
  end if;

  return query
  select distinct on (request.property_id)
    request.org_id,
    request.property_id,
    request.id,
    request.created_at,
    request.status
  from public.esign_requests request
  where request.org_id = p_org_id
    and request.property_id = any (p_property_ids)
  order by request.property_id, request.created_at desc, request.id desc;
end;
$$;

revoke all on function public.get_latest_esign_requests_for_properties(
  uuid, uuid[]
) from public, anon;
grant execute on function public.get_latest_esign_requests_for_properties(
  uuid, uuid[]
) to authenticated, service_role;

create or replace function public.esign_request_payload_is_valid(
  p_signers jsonb,
  p_merge_values jsonb,
  p_template_roles jsonb
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_typeof(p_signers) = 'array'
    and jsonb_typeof(p_merge_values) = 'object'
    and jsonb_array_length(p_signers) = jsonb_array_length(p_template_roles)
    and not exists (
      select 1
      from jsonb_array_elements(p_signers) with ordinality signer(value, position)
      join jsonb_array_elements(p_template_roles) with ordinality role(value, position)
        using (position)
      where signer.value ->> 'role' <> role.value ->> 'name'
        or btrim(coalesce(signer.value ->> 'name', '')) = ''
        or btrim(coalesce(signer.value ->> 'emailAddress', '')) = ''
    )
    and (
      select array_agg(key order by key)
      from jsonb_object_keys(p_merge_values) key
    ) = array[
      'closing_date', 'earnest_money', 'offer_price',
      'property_address', 'seller_name'
    ]::text[]
    and not exists (
      select 1 from jsonb_each(p_merge_values) item
      where jsonb_typeof(item.value) <> 'string'
        or btrim(item.value #>> '{}') = ''
    );
$$;

create or replace function public.create_esign_request(
  p_org_id uuid,
  p_property_id uuid,
  p_template_id uuid,
  p_signer_snapshot jsonb,
  p_merge_value_snapshot jsonb,
  p_send_intent_id uuid,
  p_payload_hash text,
  p_retry_of_request_id uuid,
  p_actor_id uuid
)
returns table (
  outcome public.esign_request_claim_outcome,
  blocker_code text,
  id uuid,
  org_id uuid,
  property_id uuid,
  template_id uuid,
  send_intent_id uuid,
  payload_hash text,
  retry_of_request_id uuid,
  signer_snapshot jsonb,
  merge_value_snapshot jsonb,
  status public.esign_request_status,
  delivery_state public.esign_delivery_state,
  test_mode boolean,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_id uuid := gen_random_uuid();
  v_inserted_id uuid;
  v_template public.esign_templates%rowtype;
  v_created_at timestamptz := clock_timestamp();
  v_previous public.esign_requests%rowtype;
  v_existing public.esign_requests%rowtype;
  v_property public.properties%rowtype;
  v_homeowner_email text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'payload hash must be SHA-256 hex' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships membership
    where membership.org_id = p_org_id
      and membership.user_id = p_actor_id
      and membership.access_status = 'active'
      and membership.deletion_prepared_at is null
      and (membership.access_expires_at is null or membership.access_expires_at > now())
  ) then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'ACTIVE_MEMBERSHIP_REQUIRED'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, true, null::timestamptz;
    return;
  end if;

  select * into v_existing from public.esign_requests request
  where request.org_id = p_org_id and request.send_intent_id = p_send_intent_id
  for update;
  if found then
    return query select
      case when v_existing.payload_hash = p_payload_hash
        then 'existing_same_payload'::public.esign_request_claim_outcome
        else 'intent_conflict'::public.esign_request_claim_outcome end,
      case when v_existing.payload_hash = p_payload_hash
        then null::text else 'SEND_INTENT_CONFLICT'::text end,
      v_existing.id, v_existing.org_id, v_existing.property_id,
      v_existing.template_id, v_existing.send_intent_id,
      v_existing.payload_hash, v_existing.retry_of_request_id,
      v_existing.signer_snapshot, v_existing.merge_value_snapshot,
      v_existing.status, v_existing.delivery_state, v_existing.test_mode,
      v_existing.created_at;
    return;
  end if;

  perform 1 from public.org_esign_integrations integration
  where integration.org_id = p_org_id for update;
  if not found or not exists (
    select 1 from public.org_esign_integrations integration
    where integration.org_id = p_org_id and integration.sending_enabled
      and integration.test_mode
  ) then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'ESIGN_SENDING_UNAVAILABLE'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, true, null::timestamptz;
    return;
  end if;

  select * into v_template
  from public.esign_templates template
  where template.id = p_template_id
    and template.org_id = p_org_id
    and template.deleted_at is null
    and template.finalized_at is not null
    and template.sign_template_id is not null
  for update;
  if not found then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'FINALIZED_TEMPLATE_NOT_FOUND'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, true, null::timestamptz;
    return;
  end if;

  select * into v_property from public.properties property
  where property.id = p_property_id and property.org_id = p_org_id
  for update;
  if not found then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'PROPERTY_NOT_FOUND'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, true, null::timestamptz;
    return;
  end if;
  if v_property.homeowner_contact_id is not null then
    select contact.email into v_homeowner_email from public.contacts contact
    where contact.id = v_property.homeowner_contact_id and contact.org_id = p_org_id
    for update;
  end if;
  if btrim(coalesce(v_homeowner_email, '')) = '' then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'MISSING_HOMEOWNER_EMAIL'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, true, null::timestamptz;
    return;
  end if;
  if not public.esign_request_payload_is_valid(
    p_signer_snapshot, p_merge_value_snapshot, v_template.signer_roles
  ) or not exists (
    select 1 from jsonb_array_elements(p_signer_snapshot) signer(value)
    where signer.value ->> 'role' = v_template.seller_role
      and lower(btrim(signer.value ->> 'emailAddress'))
        = lower(btrim(v_homeowner_email))
  ) then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'SIGNER_PAYLOAD_INVALID'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, true, null::timestamptz;
    return;
  end if;
  if p_retry_of_request_id is not null then
    select * into v_previous
    from public.esign_requests
    where id = p_retry_of_request_id and org_id = p_org_id
    for update;
    if not found
       or v_previous.property_id <> p_property_id
       or v_previous.template_id <> p_template_id
       or v_previous.delivery_state <> 'failed' then
      return query select
        'blocked'::public.esign_request_claim_outcome,
        'RETRY_NOT_ELIGIBLE'::text,
        null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
        p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
        p_merge_value_snapshot, null::public.esign_request_status,
        null::public.esign_delivery_state, true, null::timestamptz;
      return;
    end if;
    v_created_at := greatest(
      v_created_at,
      v_previous.created_at + interval '1 microsecond'
    );
  end if;

  insert into public.esign_requests (
    id, org_id, property_id, template_id, signer_snapshot,
    merge_value_snapshot, status, delivery_state, test_mode,
    send_intent_id, payload_hash, retry_of_request_id,
    created_by, created_at
  ) values (
    v_id, p_org_id, p_property_id, p_template_id, p_signer_snapshot,
    p_merge_value_snapshot, 'awaiting', 'sending', true,
    p_send_intent_id, p_payload_hash, p_retry_of_request_id,
    p_actor_id, v_created_at
  ) on conflict (org_id, send_intent_id) do nothing
    returning esign_requests.id into v_inserted_id;

  if v_inserted_id is null then
    select * into v_existing from public.esign_requests request
    where request.org_id = p_org_id and request.send_intent_id = p_send_intent_id
    for update;
    return query select
      case when v_existing.payload_hash = p_payload_hash
        then 'existing_same_payload'::public.esign_request_claim_outcome
        else 'intent_conflict'::public.esign_request_claim_outcome end,
      case when v_existing.payload_hash = p_payload_hash
        then null::text else 'SEND_INTENT_CONFLICT'::text end,
      v_existing.id, v_existing.org_id, v_existing.property_id,
      v_existing.template_id, v_existing.send_intent_id,
      v_existing.payload_hash, v_existing.retry_of_request_id,
      v_existing.signer_snapshot, v_existing.merge_value_snapshot,
      v_existing.status, v_existing.delivery_state, v_existing.test_mode,
      v_existing.created_at;
    return;
  end if;

  insert into public.esign_request_signers (
    org_id, request_id, role_name, signer_order, signer_name, signer_email
  )
  select
    p_org_id,
    v_id,
    signer.value ->> 'role',
    signer.position - 1,
    signer.value ->> 'name',
    signer.value ->> 'emailAddress'
  from jsonb_array_elements(p_signer_snapshot)
    with ordinality signer(value, position);

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    p_org_id, p_property_id, 'system', null, 'esign_awaiting',
    jsonb_build_object('template_title', v_template.name),
    'esign_request', v_id
  ) on conflict (source_type, source_id) where source_id is not null do nothing;
  return query select
    'created'::public.esign_request_claim_outcome, null::text,
    v_id, p_org_id, p_property_id, p_template_id, p_send_intent_id,
    p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
    p_merge_value_snapshot, 'awaiting'::public.esign_request_status,
    'sending'::public.esign_delivery_state, true, v_created_at;
end;
$$;

create or replace function public.reconcile_esign_request_delivery(
  p_org_id uuid,
  p_request_id uuid,
  p_provider_request_id text,
  p_details_url text,
  p_provider_signatures jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expected_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if btrim(coalesce(p_provider_request_id, '')) = ''
     or btrim(coalesce(p_details_url, '')) = ''
     or jsonb_typeof(p_provider_signatures) <> 'array' then
    raise exception 'provider delivery identifiers are required'
      using errcode = '23514';
  end if;
  select count(*) into v_expected_count
  from public.esign_request_signers signer
  where signer.org_id = p_org_id and signer.request_id = p_request_id;
  if v_expected_count <> jsonb_array_length(p_provider_signatures)
     or exists (
       select 1
       from jsonb_array_elements(p_provider_signatures) provided(value)
       left join public.esign_request_signers expected
         on expected.org_id = p_org_id
        and expected.request_id = p_request_id
        and expected.role_name = provided.value ->> 'role'
        and expected.signer_order = (provided.value ->> 'order')::integer
        and expected.signer_name = provided.value ->> 'name'
        and expected.signer_email = provided.value ->> 'emailAddress'
       where expected.id is null
          or btrim(coalesce(provided.value ->> 'signatureId', '')) = ''
     )
     or (
       select count(distinct provided.value ->> 'signatureId')
       from jsonb_array_elements(p_provider_signatures) provided(value)
     ) <> v_expected_count
     or (
       select count(distinct
         (provided.value ->> 'role') || E'\n' || (provided.value ->> 'order')
       )
       from jsonb_array_elements(p_provider_signatures) provided(value)
     ) <> v_expected_count then
    raise exception 'provider signatures do not match the immutable signer snapshot'
      using errcode = '23514';
  end if;

  update public.esign_request_signers signer
  set provider_signature_id = provided.value ->> 'signatureId',
      updated_at = now()
  from jsonb_array_elements(p_provider_signatures) provided(value)
  where signer.org_id = p_org_id
    and signer.request_id = p_request_id
    and signer.role_name = provided.value ->> 'role'
    and signer.signer_order = (provided.value ->> 'order')::integer;

  update public.esign_requests
  set sign_request_id = p_provider_request_id,
      details_url = p_details_url,
      delivery_state = 'sent',
      sent_at = now(),
      error_message = null,
      updated_at = now()
  where id = p_request_id
    and org_id = p_org_id
    and delivery_state in ('sending', 'send_unknown');
  if not found then
    raise exception 'eSign request is not awaiting provider reconciliation'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.mark_esign_request_send_outcome(
  p_org_id uuid,
  p_request_id uuid,
  p_delivery_state public.esign_delivery_state,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_delivery_state not in ('send_unknown', 'failed')
     or (p_delivery_state = 'failed'
       and coalesce(p_error_message, '') !~ '^[A-Z][A-Z0-9_]{0,127}$')
     or (p_delivery_state = 'send_unknown' and p_error_message is not null) then
    raise exception 'invalid send outcome' using errcode = '23514';
  end if;
  update public.esign_requests
  set delivery_state = p_delivery_state,
      status = case when p_delivery_state = 'failed' then 'error' else status end,
      completed_at = case
        when p_delivery_state = 'failed' then now() else completed_at end,
      error_message = case when p_delivery_state = 'failed'
        then p_error_message else null end,
      updated_by = null,
      updated_at = now()
  where id = p_request_id and org_id = p_org_id and delivery_state = 'sending';
  if not found then
    raise exception 'eSign request is not sending' using errcode = '55000';
  end if;
end;
$$;

create or replace function public.claim_esign_signer_reminder(
  p_org_id uuid,
  p_request_id uuid,
  p_signer_id uuid,
  p_claim_token uuid
)
returns table (
  outcome text,
  provider_request_id text,
  provider_signature_id text,
  signer_name text,
  signer_email text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_signer public.esign_request_signers%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_claim_token is null then
    raise exception 'invalid reminder lease' using errcode = '22023';
  end if;
  select * into v_request from public.esign_requests request
  where request.id = p_request_id and request.org_id = p_org_id for update;
  if not found then raise exception 'eSign request not found' using errcode = 'P0002'; end if;
  if v_request.void_claim_token is not null
     and v_request.void_claimed_at > now() - interval '10 minutes' then
    return query select 'in_progress'::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  if v_request.void_claim_token is not null then
    update public.esign_requests set void_claim_token = null, void_claimed_at = null,
      updated_at = now() where id = p_request_id and org_id = p_org_id;
  end if;
  select * into v_signer from public.esign_request_signers signer
  where signer.id = p_signer_id and signer.org_id = p_org_id
    and signer.request_id = p_request_id for update;
  if not found then raise exception 'eSign request signer not found' using errcode = 'P0002'; end if;
  if v_request.delivery_state <> 'sent'
     or v_request.status not in ('awaiting', 'viewed')
     or v_request.sign_request_id is null
     or v_request.void_requested_at is not null
     or v_signer.status not in ('awaiting', 'viewed')
     or v_signer.provider_signature_id is null
     or exists (
       select 1 from public.esign_request_signers earlier
       where earlier.org_id = p_org_id
         and earlier.request_id = p_request_id
         and earlier.signer_order < v_signer.signer_order
         and earlier.status <> 'signed'
     ) then
    return query select 'ineligible'::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  if v_signer.last_reminded_at is not null
     and v_signer.last_reminded_at > now() - interval '1 hour' then
    return query select 'cooldown'::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  if v_signer.reminder_claim_token is not null
     and v_signer.reminder_claimed_at > now() - interval '10 minutes' then
    return query select 'in_progress'::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  update public.esign_request_signers set reminder_claim_token = p_claim_token,
    reminder_claimed_at = now(), updated_at = now()
  where id = p_signer_id and org_id = p_org_id and request_id = p_request_id;
  return query select 'claimed'::text, v_request.sign_request_id,
    v_signer.provider_signature_id, v_signer.signer_name, v_signer.signer_email;
end;
$$;

create or replace function public.finalize_esign_signer_reminder(
  p_org_id uuid, p_request_id uuid, p_signer_id uuid, p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.esign_request_signers set last_reminded_at = now(),
    reminder_claim_token = null, reminder_claimed_at = null, updated_at = now()
  where id = p_signer_id and org_id = p_org_id and request_id = p_request_id
    and reminder_claim_token = p_claim_token;
  return case when found then 'applied' else 'lease_lost' end;
end;
$$;

create or replace function public.release_esign_signer_reminder(
  p_org_id uuid, p_request_id uuid, p_signer_id uuid, p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.esign_request_signers set reminder_claim_token = null,
    reminder_claimed_at = null, updated_at = now()
  where id = p_signer_id and org_id = p_org_id and request_id = p_request_id
    and reminder_claim_token = p_claim_token;
  return case when found then 'released' else 'lease_lost' end;
end;
$$;

create or replace function public.claim_esign_request_void(
  p_org_id uuid,
  p_request_id uuid,
  p_claim_token uuid
)
returns table (outcome text, provider_request_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_claim_token is null then
    raise exception 'invalid void lease' using errcode = '22023';
  end if;
  select * into v_request from public.esign_requests request
  where request.id = p_request_id and request.org_id = p_org_id for update;
  if not found then raise exception 'eSign request not found' using errcode = 'P0002'; end if;
  if exists (
    select 1 from public.esign_request_signers signer
    where signer.org_id = p_org_id and signer.request_id = p_request_id
      and signer.reminder_claim_token is not null
      and signer.reminder_claimed_at > now() - interval '10 minutes'
  ) then
    return query select 'in_progress'::text, null::text; return;
  end if;
  update public.esign_request_signers set reminder_claim_token = null,
    reminder_claimed_at = null, updated_at = now()
  where org_id = p_org_id and request_id = p_request_id
    and reminder_claim_token is not null
    and reminder_claimed_at <= now() - interval '10 minutes';
  if v_request.delivery_state <> 'sent'
     or v_request.status not in ('awaiting', 'viewed')
     or v_request.sign_request_id is null
     or v_request.void_requested_at is not null then
    return query select 'ineligible'::text, null::text; return;
  end if;
  if v_request.void_claim_token is not null
     and v_request.void_claimed_at > now() - interval '10 minutes' then
    return query select 'in_progress'::text, null::text; return;
  end if;
  update public.esign_requests set void_claim_token = p_claim_token,
    void_claimed_at = now(), updated_at = now()
  where id = p_request_id and org_id = p_org_id;
  return query select 'claimed'::text, v_request.sign_request_id;
end;
$$;

create or replace function public.finalize_esign_request_void(
  p_org_id uuid, p_request_id uuid, p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.esign_requests set void_requested_at = now(),
    void_claim_token = null, void_claimed_at = null, updated_at = now()
  where id = p_request_id and org_id = p_org_id
    and void_claim_token = p_claim_token and status in ('awaiting', 'viewed')
    and delivery_state = 'sent';
  return case when found then 'applied' else 'lease_lost' end;
end;
$$;

create or replace function public.release_esign_request_void(
  p_org_id uuid, p_request_id uuid, p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.esign_requests set void_claim_token = null,
    void_claimed_at = null, updated_at = now()
  where id = p_request_id and org_id = p_org_id
    and void_claim_token = p_claim_token;
  return case when found then 'released' else 'lease_lost' end;
end;
$$;

revoke all on function public.create_esign_request(
  uuid, uuid, uuid, jsonb, jsonb, uuid, text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.create_esign_request(
  uuid, uuid, uuid, jsonb, jsonb, uuid, text, uuid, uuid
) to service_role;
revoke all on function public.reconcile_esign_request_delivery(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.reconcile_esign_request_delivery(
  uuid, uuid, text, text, jsonb
) to service_role;
revoke all on function public.mark_esign_request_send_outcome(
  uuid, uuid, public.esign_delivery_state, text
) from public, anon, authenticated;
grant execute on function public.mark_esign_request_send_outcome(
  uuid, uuid, public.esign_delivery_state, text
) to service_role;
revoke all on function public.claim_esign_signer_reminder(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.claim_esign_signer_reminder(
  uuid, uuid, uuid, uuid
) to service_role;
revoke all on function public.finalize_esign_signer_reminder(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_esign_signer_reminder(uuid, uuid, uuid, uuid)
  to service_role;
revoke all on function public.release_esign_signer_reminder(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.release_esign_signer_reminder(uuid, uuid, uuid, uuid)
  to service_role;
revoke all on function public.claim_esign_request_void(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_esign_request_void(uuid, uuid, uuid)
  to service_role;
revoke all on function public.finalize_esign_request_void(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_esign_request_void(uuid, uuid, uuid)
  to service_role;
revoke all on function public.release_esign_request_void(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.release_esign_request_void(uuid, uuid, uuid)
  to service_role;

create or replace function public.find_esign_webhook_request(
  p_org_id uuid,
  p_sign_request_id text
)
returns table (
  id uuid,
  org_id uuid,
  property_id uuid,
  status public.esign_request_status,
  signed_pdf_path text,
  template_title text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select request.id, request.org_id, request.property_id, request.status,
    request.signed_pdf_path, template.name
  from public.esign_requests request
  join public.esign_templates template
    on template.id = request.template_id and template.org_id = request.org_id
  where request.org_id = p_org_id
    and request.sign_request_id = p_sign_request_id
    and coalesce(auth.role(), '') = 'service_role'
  limit 1;
$$;

revoke all on function public.find_esign_webhook_request(uuid, text)
  from public, anon, authenticated;
grant execute on function public.find_esign_webhook_request(uuid, text)
  to service_role;

create or replace function public.apply_esign_webhook_status_decision(
  p_org_id uuid,
  p_request_id uuid,
  p_receipt_id uuid,
  p_lease_id uuid,
  p_expected_status public.esign_request_status,
  p_requested_status public.esign_request_status,
  p_provider_event_at timestamptz,
  p_lead_event_type text,
  p_lead_event_payload jsonb
)
returns table (outcome text, status public.esign_request_status)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_related_signer public.esign_request_signers%rowtype;
  v_template_title text;
  v_event_type text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider_event_at is null then
    raise exception 'invalid provider status decision' using errcode = '22023';
  end if;
  select request.* into v_request
  from public.esign_requests request
  where request.id = p_request_id and request.org_id = p_org_id
  for update;
  if not found then
    raise exception 'eSign request not found' using errcode = 'P0002';
  end if;
  perform 1 from public.esign_webhook_receipts receipt
  where receipt.id = p_receipt_id
    and receipt.org_id = p_org_id
    and receipt.processing_status = 'processing'
    and receipt.processing_lease_id = p_lease_id
    and receipt.sign_request_id = v_request.sign_request_id
    and receipt.provider_event_at is not distinct from p_provider_event_at
    and (receipt.esign_request_id = p_request_id or receipt.esign_request_id is null)
    and (
      (receipt.event_type = 'signature_request_viewed'
        and p_requested_status = 'viewed')
      or (receipt.event_type = 'signature_request_all_signed'
        and p_requested_status = 'signed')
      or (receipt.event_type = 'signature_request_downloadable'
        and p_requested_status = 'signed')
      or (receipt.event_type = 'signature_request_declined'
        and p_requested_status = 'declined')
      or (receipt.event_type = 'signature_request_canceled'
        and p_requested_status = 'voided')
      or (receipt.event_type in (
          'signature_request_invalid',
          'signature_request_expired',
          'signature_request_email_bounce'
        )
        and p_requested_status = 'error')
    )
  for update;
  if not found then
    raise exception 'active matching webhook receipt lease not found'
      using errcode = 'P0002';
  end if;
  if v_request.status in ('signed', 'declined', 'voided', 'error') then
    return query select 'terminal_ignored'::text, v_request.status; return;
  end if;
  if p_requested_status in ('viewed', 'declined') then
    select signer.* into v_related_signer
    from public.esign_request_signers signer
    join public.esign_webhook_receipts receipt
      on receipt.id = p_receipt_id
    where signer.org_id = p_org_id
      and signer.request_id = p_request_id
      and receipt.related_signature_id is not null
      and signer.provider_signature_id = receipt.related_signature_id
    for update of signer;
    if not found then
      raise exception 'matching eSign request signer not found'
        using errcode = 'P0002';
    end if;
    if v_related_signer.status not in ('awaiting', 'viewed') then
      return query select 'no_change'::text, v_request.status; return;
    end if;
  end if;
  if v_request.status <> p_expected_status
     or v_request.status = p_requested_status
     or (v_request.provider_event_at is not null
       and p_provider_event_at < v_request.provider_event_at) then
    return query select 'no_change'::text, v_request.status; return;
  end if;
  if not (
    (v_request.status = 'awaiting'
      and p_requested_status in ('viewed', 'signed', 'declined', 'voided', 'error'))
    or (v_request.status = 'viewed'
      and p_requested_status in ('signed', 'declined', 'voided', 'error'))
  ) then
    return query select 'no_change'::text, v_request.status; return;
  end if;

  if p_requested_status = 'viewed' then
    update public.esign_request_signers signer
    set status = case when signer.status = 'awaiting' then 'viewed' else signer.status end,
        viewed_at = case when signer.status = 'awaiting'
          then coalesce(signer.viewed_at, p_provider_event_at) else signer.viewed_at end,
        reminder_claim_token = null,
        reminder_claimed_at = null,
        updated_at = now()
    from public.esign_webhook_receipts receipt
    where receipt.id = p_receipt_id
      and signer.org_id = p_org_id
      and signer.request_id = p_request_id
      and receipt.related_signature_id is not null
      and signer.provider_signature_id = receipt.related_signature_id;
  elsif p_requested_status = 'signed' then
    update public.esign_request_signers signer
    set status = 'signed',
        viewed_at = coalesce(signer.viewed_at, p_provider_event_at),
        signed_at = coalesce(signer.signed_at, p_provider_event_at),
        reminder_claim_token = null,
        reminder_claimed_at = null,
        updated_at = now()
    where signer.org_id = p_org_id and signer.request_id = p_request_id
      and signer.status not in ('declined', 'error');
  elsif p_requested_status = 'declined' then
    update public.esign_request_signers signer
    set status = 'declined',
        declined_at = coalesce(signer.declined_at, p_provider_event_at),
        reminder_claim_token = null,
        reminder_claimed_at = null,
        updated_at = now()
    from public.esign_webhook_receipts receipt
    where receipt.id = p_receipt_id
      and signer.org_id = p_org_id
      and signer.request_id = p_request_id
      and receipt.related_signature_id is not null
      and signer.provider_signature_id = receipt.related_signature_id
      and signer.status in ('awaiting', 'viewed');
  elsif p_requested_status = 'error' then
    update public.esign_request_signers signer
    set status = 'error',
        reminder_claim_token = null,
        reminder_claimed_at = null,
        updated_at = now()
    where signer.org_id = p_org_id and signer.request_id = p_request_id
      and signer.status not in ('signed', 'declined');
  end if;

  v_event_type := case p_requested_status
    when 'viewed' then 'esign_viewed'
    when 'signed' then 'esign_signed'
    when 'declined' then 'esign_declined'
    when 'voided' then 'esign_voided'
    else null
  end;
  select template.name into v_template_title
  from public.esign_templates template
  where template.id = v_request.template_id and template.org_id = p_org_id;
  if (v_event_type is null and (
        p_lead_event_type is not null or p_lead_event_payload is not null
      ))
     or (v_event_type is not null and (
       p_lead_event_type is distinct from v_event_type
       or p_lead_event_payload is distinct from
          jsonb_build_object('template_title', v_template_title)
     )) then
    raise exception 'eSign material activity contract is invalid'
      using errcode = '23514';
  end if;

  update public.esign_webhook_receipts
  set esign_request_id = p_request_id
  where id = p_receipt_id and org_id = p_org_id;

  update public.esign_requests
  set status = p_requested_status,
      provider_event_at = greatest(
        coalesce(provider_event_at, p_provider_event_at), p_provider_event_at
      ),
      completed_at = case
        when p_requested_status in ('signed', 'declined', 'voided', 'error')
          then p_provider_event_at
        else null
      end,
      void_requested_at = case
        when p_requested_status = 'voided'
          then coalesce(void_requested_at, p_provider_event_at)
        else void_requested_at
      end,
      void_claim_token = case
        when p_requested_status in ('signed', 'declined', 'voided', 'error')
          then null else void_claim_token end,
      void_claimed_at = case
        when p_requested_status in ('signed', 'declined', 'voided', 'error')
          then null else void_claimed_at end,
      error_message = case
        when p_requested_status = 'error' then 'PROVIDER_ERROR'
        else error_message
      end,
      updated_by = null,
      updated_at = now()
  where id = p_request_id and org_id = p_org_id;
  if p_requested_status in ('signed', 'declined', 'voided', 'error') then
    update public.esign_request_signers
    set reminder_claim_token = null, reminder_claimed_at = null,
        updated_at = now()
    where org_id = p_org_id and request_id = p_request_id;
  end if;

  if v_event_type is not null then
    insert into public.lead_events (
      org_id, property_id, actor_type, actor_id, event_type, payload,
      source_type, source_id
    ) values (
      p_org_id, v_request.property_id, 'system', null, v_event_type,
      jsonb_build_object('template_title', v_template_title),
      'esign_status_receipt', p_receipt_id
    ) on conflict (source_type, source_id) where source_id is not null do nothing;
    if not exists (
      select 1 from public.lead_events event
      where event.source_type = 'esign_status_receipt'
        and event.source_id = p_receipt_id
        and event.org_id = p_org_id
        and event.property_id = v_request.property_id
        and event.actor_type = 'system'
        and event.actor_id is null
        and event.event_type = v_event_type
        and event.payload = jsonb_build_object(
          'template_title', v_template_title
        )
    ) then
      raise exception 'conflicting eSign status activity event exists'
        using errcode = '23514';
    end if;
  end if;
  return query select 'applied'::text, p_requested_status;
end;
$$;

revoke all on function public.apply_esign_webhook_status_decision(
  uuid, uuid, uuid, uuid, public.esign_request_status,
  public.esign_request_status, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_esign_webhook_status_decision(
  uuid, uuid, uuid, uuid, public.esign_request_status,
  public.esign_request_status, timestamptz, text, jsonb
) to service_role;

revoke all on table public.lead_files
  from public, anon, authenticated, service_role;
grant select on table public.lead_files to authenticated;
grant all on table public.lead_files to service_role;

create or replace function public.link_esign_signed_artifact(
  p_org_id uuid,
  p_request_id uuid,
  p_receipt_id uuid,
  p_lease_id uuid,
  p_lead_file_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_content_type text,
  p_size_bytes bigint,
  p_lead_event_type text,
  p_lead_event_payload jsonb
)
returns table (outcome text, lead_file_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_existing public.lead_files%rowtype;
  v_template_title text;
  v_expected_path text;
  v_expected_name text;
  v_outcome text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select request.* into v_request
  from public.esign_requests request
  where request.id = p_request_id
    and request.org_id = p_org_id
    and request.status = 'signed'
  for update;
  if not found then
    raise exception 'signed eSign request not found' using errcode = 'P0002';
  end if;
  perform 1 from public.esign_webhook_receipts receipt
  where receipt.id = p_receipt_id
    and receipt.org_id = p_org_id
    and receipt.processing_status = 'processing'
    and receipt.processing_lease_id = p_lease_id
    and receipt.event_type = 'signature_request_downloadable'
    and receipt.sign_request_id = v_request.sign_request_id
    and (receipt.esign_request_id = p_request_id or receipt.esign_request_id is null)
  for update;
  if not found then
    raise exception 'active downloadable webhook receipt lease not found'
      using errcode = 'P0002';
  end if;
  v_expected_path := p_org_id::text || '/' || v_request.property_id::text
    || '/esign/' || p_request_id::text || '/signed.pdf';
  v_expected_name := 'signed-contract-'
    || left(p_request_id::text, 8) || '.pdf';
  select template.name into v_template_title
  from public.esign_templates template
  where template.id = v_request.template_id and template.org_id = p_org_id;
  if p_lead_file_id is null
     or p_storage_bucket <> 'lead-files'
     or p_storage_path <> v_expected_path
     or p_content_type <> 'application/pdf'
     or p_size_bytes <= 0
     or p_size_bytes > 41943040
     or p_lead_event_type <> 'esign_signed_pdf_ready'
     or p_lead_event_payload is distinct from
       jsonb_build_object('template_title', v_template_title) then
    raise exception 'signed PDF artifact metadata is invalid'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from storage.objects object
    where object.bucket_id = p_storage_bucket and object.name = v_expected_path
      and nullif(object.metadata ->> 'size', '')::bigint = p_size_bytes
      and coalesce(object.metadata ->> 'mimetype', object.metadata ->> 'contentType')
        = p_content_type
  ) then
    raise exception 'signed PDF storage object not found' using errcode = 'P0002';
  end if;

  select file.* into v_existing
  from public.lead_files file
  where file.org_id = p_org_id
    and file.source_request_id = p_request_id
    and file.source = 'esign_signed_pdf'
  for update;
  if found then
    if v_existing.property_id <> v_request.property_id
       or v_existing.storage_path <> v_expected_path
       or v_existing.file_name <> v_expected_name
       or v_existing.content_type <> 'application/pdf'
       or v_existing.size_bytes <> p_size_bytes then
      raise exception 'conflicting signed PDF linkage exists'
        using errcode = '23514';
    end if;
    v_outcome := 'already_linked';
  else
    if v_request.signed_pdf_path is not null
       and v_request.signed_pdf_path <> v_expected_path then
      raise exception 'conflicting signed PDF path exists'
        using errcode = '23514';
    end if;
    insert into public.lead_files (
      id, org_id, property_id, source_request_id, file_name, content_type,
      size_bytes, storage_bucket, storage_path, source, created_by
    ) values (
      p_lead_file_id, p_org_id, v_request.property_id, p_request_id,
      v_expected_name, 'application/pdf', p_size_bytes,
      'lead-files', v_expected_path, 'esign_signed_pdf', null
    );
    v_existing.id := p_lead_file_id;
    v_outcome := 'applied';
  end if;

  update public.esign_webhook_receipts
  set esign_request_id = p_request_id
  where id = p_receipt_id and org_id = p_org_id;
  update public.esign_requests
  set signed_pdf_path = v_expected_path, updated_at = now(), updated_by = null
  where id = p_request_id and org_id = p_org_id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    p_org_id, v_request.property_id, 'system', null,
    'esign_signed_pdf_ready',
    jsonb_build_object('template_title', v_template_title),
    'esign_signed_pdf_request', p_request_id
  ) on conflict (source_type, source_id) where source_id is not null do nothing;
  if not exists (
    select 1 from public.lead_events event
    where event.source_type = 'esign_signed_pdf_request'
      and event.source_id = p_request_id
      and event.org_id = p_org_id
      and event.property_id = v_request.property_id
      and event.actor_type = 'system'
      and event.actor_id is null
      and event.event_type = 'esign_signed_pdf_ready'
      and event.payload = jsonb_build_object(
        'template_title', v_template_title
      )
  ) then
    raise exception 'conflicting signed PDF activity event exists'
      using errcode = '23514';
  end if;
  return query select v_outcome, v_existing.id;
end;
$$;

revoke all on function public.link_esign_signed_artifact(
  uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, text, jsonb
) from public, anon, authenticated;
grant execute on function public.link_esign_signed_artifact(
  uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, text, jsonb
) to service_role;

create or replace function public.upsert_org_esign_integration(
  p_org_id uuid,
  p_api_key text,
  p_api_key_last_four text,
  p_client_id text,
  p_callback_secret_hash text,
  p_actor_id uuid,
  p_key text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_callback_consumer_id uuid := gen_random_uuid();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if btrim(p_api_key) = '' or btrim(p_key) = '' then
    raise exception 'API key and encryption key are required'
      using errcode = '22023';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if exists (
    select 1 from public.org_esign_integrations integration
    where integration.org_id = p_org_id
  ) then
    raise exception 'Dropbox Sign is already connected; disconnect safely before reconnecting.'
      using errcode = '55000';
  end if;

  insert into public.webhook_consumers (
    id, name, secret_hash, consumer_type, default_source, org_id, enabled,
    created_by
  ) values (
    v_callback_consumer_id,
    'Dropbox Sign (' || p_org_id::text || ') '
      || v_callback_consumer_id::text,
    p_callback_secret_hash,
    'esign_provider',
    null,
    p_org_id,
    true,
    p_actor_id
  );

  if not exists (
    select 1 from public.webhook_consumers consumer
    where consumer.id = v_callback_consumer_id
      and consumer.org_id = p_org_id
      and consumer.consumer_type = 'esign_provider'
      and consumer.enabled
      and consumer.revoked_at is null
  ) then
    raise exception 'dedicated Dropbox Sign callback consumer is unavailable'
      using errcode = '23514';
  end if;

  insert into public.org_esign_integrations (
    org_id, api_key_encrypted, api_key_last_four, client_id,
    callback_consumer_id, sending_enabled, test_mode, connected_by, updated_by
  ) values (
    p_org_id,
    extensions.pgp_sym_encrypt(p_api_key, p_key, 'cipher-algo=aes256'),
    p_api_key_last_four,
    p_client_id,
    v_callback_consumer_id,
    false,
    true,
    p_actor_id,
    p_actor_id
  );
end;
$$;

create or replace function public.get_org_esign_credentials(
  p_org_id uuid,
  p_key text
)
returns table (
  api_key text,
  client_id text,
  sending_enabled boolean,
  test_mode boolean,
  callback_secret_hash text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    extensions.pgp_sym_decrypt(integration.api_key_encrypted, p_key),
    integration.client_id,
    integration.sending_enabled,
    integration.test_mode,
    consumer.secret_hash
  from public.org_esign_integrations integration
  join public.webhook_consumers consumer
    on consumer.id = integration.callback_consumer_id
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
    and coalesce(auth.role(), '') = 'service_role';
$$;

revoke all on function public.upsert_org_esign_integration(
  uuid, text, text, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.upsert_org_esign_integration(
  uuid, text, text, text, text, uuid, text
) to service_role;

revoke all on function public.get_org_esign_credentials(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_org_esign_credentials(uuid, text)
  to service_role;

create or replace function public.delete_org_esign_integration(
  p_org_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_callback_consumer_id uuid;
  v_pending_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);

  select callback_consumer_id into v_callback_consumer_id
  from public.org_esign_integrations
  where org_id = p_org_id
  for update;
  if not found then
    raise exception 'Dropbox Sign is not connected' using errcode = 'P0002';
  end if;

  select count(*) into v_pending_count
  from public.esign_requests request
  where request.org_id = p_org_id
    and (
      request.status in ('awaiting', 'viewed')
      or request.delivery_state in ('sending', 'send_unknown')
      or (
        request.status = 'signed'
        and not exists (
          select 1
          from public.lead_files file
          join storage.objects object
            on object.bucket_id = file.storage_bucket
           and object.name = file.storage_path
          where file.org_id = request.org_id
            and file.source_request_id = request.id
            and file.storage_bucket = 'lead-files'
            and file.storage_path = request.signed_pdf_path
        )
      )
    );
  if v_pending_count > 0 then
    raise exception 'Finish active signatures and save signed PDFs before disconnecting Dropbox Sign.'
      using errcode = '23514';
  end if;

  delete from public.org_esign_integrations where org_id = p_org_id;
  update public.webhook_consumers
  set enabled = false,
      revoked_at = now(),
      secret_hash = encode(
        extensions.digest(
          convert_to(secret_hash || ':' || id::text, 'utf8'),
          'sha256'
        ),
        'hex'
      )
  where id = v_callback_consumer_id and consumer_type = 'esign_provider';
end;
$$;

revoke all on function public.delete_org_esign_integration(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_org_esign_integration(uuid, uuid)
  to service_role;

create or replace function public.set_org_esign_sending_enabled(
  p_org_id uuid,
  p_actor_id uuid,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_integration public.org_esign_integrations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_integration
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
  for update;
  if not found then
    raise exception 'Dropbox Sign is not connected' using errcode = 'P0002';
  end if;
  if p_enabled and v_integration.callback_verified_at is null then
    raise exception 'Verify the Dropbox Sign callback before enabling sending'
      using errcode = '23514';
  end if;
  update public.org_esign_integrations
  set sending_enabled = p_enabled,
      updated_by = p_actor_id,
      updated_at = now()
  where org_id = p_org_id;
end;
$$;

revoke all on function public.set_org_esign_sending_enabled(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_org_esign_sending_enabled(uuid, uuid, boolean)
  to service_role;

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
values
  (
    'esign-staging', 'esign-staging', false, 41943040,
    array['application/pdf']::text[]
  ),
  (
    'lead-files', 'lead-files', false, 41943040,
    array['application/pdf']::text[]
  )
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.esign_storage_org_id(p_path text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when (storage.foldername(p_path))[1] ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then (storage.foldername(p_path))[1]::uuid
    else null
  end;
$$;

create or replace function public.esign_staging_path_is_valid(p_path text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$';
$$;

create policy "esign_staging_owner_select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'esign-staging'
    and public.esign_staging_path_is_valid(name)
    and public.esign_is_active_org_owner(public.esign_storage_org_id(name))
  );
create policy "esign_staging_owner_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'esign-staging'
    and public.esign_staging_path_is_valid(name)
    and public.esign_is_active_org_owner(public.esign_storage_org_id(name))
  );
create policy "lead_files_member_select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'lead-files'
    and public.hugo_has_active_org_access(public.esign_storage_org_id(name))
  );

-- Session 04 owns receipt processing. This foundation deliberately does not
-- treat Dropbox's event_hash as unique: the documented HMAC input omits the
-- request and signer identities.
create or replace function public.esign_safe_event_data_is_valid(p_data jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_typeof(p_data) = 'object', false)
    and coalesce(
      (select array_agg(key order by key) from jsonb_object_keys(p_data) key),
      array[]::text[]
    )
      = array[
        'event_time', 'event_type', 'related_signature_id',
        'reported_for_app_id', 'sign_request_id'
      ]::text[]
    and jsonb_typeof(p_data -> 'event_time') = 'string'
    and (p_data ->> 'event_time') ~ '^[0-9]{1,20}$'
    and (p_data ->> 'event_time')::numeric <= 253402300799
    and jsonb_typeof(p_data -> 'event_type') = 'string'
    and (p_data ->> 'event_type') ~ '^[a-z0-9_]{1,128}$'
    and not exists (
      select 1 from jsonb_each(p_data) item
      where item.key in (
          'sign_request_id', 'related_signature_id', 'reported_for_app_id'
        )
        and jsonb_typeof(item.value) not in ('string', 'null')
        or (
          item.key in (
            'sign_request_id', 'related_signature_id', 'reported_for_app_id'
          )
          and jsonb_typeof(item.value) = 'string'
          and char_length(item.value #>> '{}') not between 1 and 256
        )
    );
$$;

create table public.esign_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  callback_consumer_id uuid not null,
  esign_request_id uuid,
  event_hash text not null check (event_hash ~ '^[a-f0-9]{64}$'),
  event_fingerprint text not null check (event_fingerprint ~ '^[a-f0-9]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  event_type text not null check (btrim(event_type) <> ''),
  sign_request_id text,
  related_signature_id text,
  provider_event_at timestamptz,
  safe_event_data jsonb not null
    check (public.esign_safe_event_data_is_valid(safe_event_data)),
  received_at timestamptz not null default now(),
  processing_status text not null default 'pending'
    check (processing_status in (
      'pending', 'processing', 'processed', 'ignored', 'error'
    )),
  processing_started_at timestamptz,
  processing_lease_id uuid,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  processed_at timestamptz,
  processing_error text check (
    processing_error is null
    or processing_error ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint esign_webhook_receipts_callback_consumer_org_fkey
    foreign key (callback_consumer_id, org_id)
    references public.webhook_consumers(id, org_id) on delete restrict,
  constraint esign_webhook_receipts_request_org_fkey
    foreign key (esign_request_id, org_id)
    references public.esign_requests(id, org_id) on delete restrict,
  constraint esign_webhook_receipts_org_fingerprint_key
    unique (org_id, event_fingerprint),
  constraint esign_webhook_receipts_processing_state_check check (
    (processing_status = 'pending'
      and processing_started_at is null
      and processing_lease_id is null
      and processed_at is null)
    or (processing_status = 'processing'
      and processing_started_at is not null
      and processing_lease_id is not null
      and processed_at is null)
    or (processing_status in ('processed', 'ignored')
      and processed_at is not null
      and processing_lease_id is null)
    or (processing_status = 'error'
      and processing_error is not null
      and processing_lease_id is null
      and processed_at is null)
  )
);

comment on column public.esign_webhook_receipts.event_hash is
  'Dropbox authenticity HMAC. Deliberately not unique because its input omits request and signer identity.';
comment on column public.esign_webhook_receipts.event_fingerprint is
  'Org-scoped SHA-256 over event_hash plus request/signature identity and event type for idempotent processing.';
comment on column public.esign_webhook_receipts.payload_hash is
  'SHA-256 of the exact raw Dropbox Sign JSON form field. The raw callback payload is never persisted.';
comment on column public.esign_webhook_receipts.safe_event_data is
  'Normalized non-PII event identity/status data only. Raw callback bodies are not persisted.';

create index idx_esign_webhook_receipts_request
  on public.esign_webhook_receipts
  (org_id, sign_request_id, provider_event_at desc, received_at desc);
create index idx_esign_webhook_receipts_claimable
  on public.esign_webhook_receipts
  (processing_status, processing_started_at, received_at)
  where processing_status in ('pending', 'processing', 'error');
alter table public.esign_webhook_receipts enable row level security;
revoke all on table public.esign_webhook_receipts
  from public, anon, authenticated, service_role;
grant all on table public.esign_webhook_receipts to service_role;

create or replace function public.claim_verified_esign_webhook_receipt(
  p_org_id uuid,
  p_callback_consumer_id uuid,
  p_event_hash text,
  p_event_fingerprint text,
  p_payload_hash text,
  p_event_type text,
  p_sign_request_id text,
  p_related_signature_id text,
  p_safe_event_data jsonb,
  p_provider_event_at timestamptz,
  p_received_at timestamptz,
  p_lease_id uuid,
  p_stale_after interval default interval '5 minutes'
)
returns table (outcome text, receipt_id uuid, lease_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted_id uuid;
  v_request_id uuid;
  v_receipt public.esign_webhook_receipts%rowtype;
  v_safe_event_data jsonb := coalesce(p_safe_event_data, '{}'::jsonb);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_id is null
     or p_stale_after < interval '1 minute'
     or p_stale_after > interval '1 hour'
     or p_event_hash !~ '^[a-f0-9]{64}$'
     or p_event_fingerprint !~ '^[a-f0-9]{64}$'
     or p_payload_hash !~ '^[a-f0-9]{64}$'
     or btrim(coalesce(p_event_type, '')) = ''
     or p_received_at is null then
    raise exception 'invalid verified receipt input' using errcode = '22023';
  end if;
  if not public.esign_safe_event_data_is_valid(v_safe_event_data) then
    raise exception 'invalid safe event data' using errcode = '22023';
  end if;
  if (v_safe_event_data ? 'event_type'
       and v_safe_event_data ->> 'event_type' <> p_event_type)
     or to_timestamp((v_safe_event_data ->> 'event_time')::numeric)
       is distinct from p_provider_event_at
     or (v_safe_event_data ? 'sign_request_id'
       and v_safe_event_data ->> 'sign_request_id' is distinct from p_sign_request_id)
     or (v_safe_event_data ? 'related_signature_id'
       and v_safe_event_data ->> 'related_signature_id'
         is distinct from p_related_signature_id) then
    raise exception 'safe event data conflicts with normalized receipt identity'
      using errcode = '23514';
  end if;

  perform 1 from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.callback_consumer_id = p_callback_consumer_id
  for update;
  if not found or not exists (
    select 1 from public.webhook_consumers consumer
    where consumer.id = p_callback_consumer_id
      and consumer.org_id = p_org_id
      and consumer.consumer_type = 'esign_provider'
      and consumer.enabled
      and consumer.revoked_at is null
  ) then
    raise exception 'active dedicated eSign callback consumer not found'
      using errcode = '42501';
  end if;
  update public.org_esign_integrations
  set callback_verified_at = coalesce(callback_verified_at, now()),
      updated_at = now()
  where org_id = p_org_id and callback_consumer_id = p_callback_consumer_id;

  select request.id into v_request_id
  from public.esign_requests request
  where request.org_id = p_org_id
    and request.sign_request_id = p_sign_request_id;

  insert into public.esign_webhook_receipts (
    org_id, callback_consumer_id, esign_request_id, event_hash,
    event_fingerprint, payload_hash, event_type, sign_request_id,
    related_signature_id, provider_event_at, safe_event_data, received_at,
    processing_status, processing_started_at, processing_lease_id,
    attempt_count
  ) values (
    p_org_id, p_callback_consumer_id, v_request_id, p_event_hash,
    p_event_fingerprint, p_payload_hash, p_event_type, p_sign_request_id,
    p_related_signature_id, p_provider_event_at, v_safe_event_data,
    p_received_at, 'processing', now(), p_lease_id, 1
  )
  on conflict (org_id, event_fingerprint) do nothing
  returning id into v_inserted_id;
  if v_inserted_id is not null then
    return query select 'claimed'::text, v_inserted_id, p_lease_id;
    return;
  end if;

  select receipt.* into v_receipt
  from public.esign_webhook_receipts receipt
  where receipt.org_id = p_org_id
    and receipt.event_fingerprint = p_event_fingerprint
  for update;
  if not found then
    raise exception 'verified receipt conflict could not be resolved'
      using errcode = '40001';
  end if;
  if v_receipt.event_hash <> p_event_hash
     or v_receipt.payload_hash <> p_payload_hash
     or v_receipt.event_type <> p_event_type
     or v_receipt.sign_request_id is distinct from p_sign_request_id
     or v_receipt.related_signature_id is distinct from p_related_signature_id
     or v_receipt.provider_event_at is distinct from p_provider_event_at
     or v_receipt.safe_event_data <> v_safe_event_data then
    raise exception 'verified receipt fingerprint collision'
      using errcode = '23514';
  end if;
  if v_receipt.processing_status in ('processed', 'ignored') then
    return query select 'already_processed'::text, v_receipt.id, null::uuid;
    return;
  end if;
  if v_receipt.processing_status = 'processing'
     and v_receipt.processing_started_at >= now() - p_stale_after then
    return query select 'in_progress'::text, v_receipt.id, null::uuid;
    return;
  end if;

  update public.esign_webhook_receipts receipt
  set esign_request_id = coalesce(receipt.esign_request_id, v_request_id),
      processing_status = 'processing',
      processing_started_at = now(),
      processing_lease_id = p_lease_id,
      processing_error = null,
      attempt_count = receipt.attempt_count + 1
  where receipt.id = v_receipt.id;
  return query select 'claimed'::text, v_receipt.id, p_lease_id;
end;
$$;

create or replace function public.claim_esign_webhook_receipt(
  p_org_id uuid,
  p_callback_consumer_id uuid,
  p_event_hash text,
  p_event_fingerprint text,
  p_payload_hash text,
  p_event_type text,
  p_sign_request_id text,
  p_related_signature_id text,
  p_provider_event_at timestamptz,
  p_safe_event_data jsonb,
  p_received_at timestamptz,
  p_lease_id uuid,
  p_stale_after_seconds integer
)
returns table (outcome text, receipt_id uuid, lease_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_stale_after_seconds not between 60 and 3600 then
    raise exception 'invalid receipt lease' using errcode = '22023';
  end if;
  return query
  select claim.outcome, claim.receipt_id, claim.lease_id
  from public.claim_verified_esign_webhook_receipt(
    p_org_id, p_callback_consumer_id, p_event_hash, p_event_fingerprint,
    p_payload_hash, p_event_type, p_sign_request_id,
    p_related_signature_id, p_safe_event_data, p_provider_event_at,
    p_received_at, p_lease_id,
    make_interval(secs => p_stale_after_seconds)
  ) claim;
end;
$$;

create or replace function public.complete_esign_webhook_receipt(
  p_receipt_id uuid,
  p_lease_id uuid,
  p_status text,
  p_safe_code text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt public.esign_webhook_receipts%rowtype;
  v_request_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_status not in ('processed', 'ignored', 'error')
     or (p_status in ('ignored', 'error')
       and coalesce(p_safe_code, '') !~ '^[A-Z][A-Z0-9_]{0,63}$')
     or (p_status = 'processed' and p_safe_code is not null) then
    raise exception 'invalid receipt completion state' using errcode = '22023';
  end if;
  select * into v_receipt
  from public.esign_webhook_receipts receipt
  where receipt.id = p_receipt_id
    and receipt.processing_status = 'processing'
    and receipt.processing_lease_id = p_lease_id
  for update;
  if not found then
    raise exception 'receipt lease is not active' using errcode = '55000';
  end if;
  if p_status = 'ignored'
     and p_safe_code = 'AUDIT_ONLY_EVENT'
     and v_receipt.event_type = 'signature_request_signed' then
    if v_receipt.sign_request_id is null
       or v_receipt.related_signature_id is null
       or v_receipt.provider_event_at is null then
      raise exception 'signed callback identity is incomplete'
        using errcode = '23514';
    end if;
    select request.id into v_request_id
    from public.esign_requests request
    where request.org_id = v_receipt.org_id
      and request.sign_request_id = v_receipt.sign_request_id
    for update;
    if not found then
      raise exception 'eSign request not found' using errcode = 'P0002';
    end if;
    update public.esign_request_signers signer
    set status = 'signed',
        viewed_at = coalesce(signer.viewed_at, v_receipt.provider_event_at),
        signed_at = coalesce(signer.signed_at, v_receipt.provider_event_at),
        reminder_claim_token = null,
        reminder_claimed_at = null,
        updated_at = now()
    where signer.org_id = v_receipt.org_id
      and signer.request_id = v_request_id
      and signer.provider_signature_id = v_receipt.related_signature_id
      and signer.status not in ('declined', 'error');
    if not found then
      raise exception 'eSign request signer not found' using errcode = 'P0002';
    end if;
    update public.esign_webhook_receipts
    set esign_request_id = v_request_id
    where id = p_receipt_id;
  end if;
  update public.esign_webhook_receipts
  set processing_status = p_status,
      processing_lease_id = null,
      processed_at = case
        when p_status in ('processed', 'ignored') then now()
        else null
      end,
      processing_error = case
        when p_status in ('ignored', 'error') then p_safe_code else null end
  where id = p_receipt_id
    and processing_status = 'processing'
    and processing_lease_id = p_lease_id;
  if not found then
    raise exception 'receipt lease is not active' using errcode = '55000';
  end if;
end;
$$;

revoke all on function public.claim_verified_esign_webhook_receipt(
  uuid, uuid, text, text, text, text, text, text, jsonb,
  timestamptz, timestamptz, uuid, interval
) from public, anon, authenticated;
grant execute on function public.claim_verified_esign_webhook_receipt(
  uuid, uuid, text, text, text, text, text, text, jsonb,
  timestamptz, timestamptz, uuid, interval
) to service_role;

revoke all on function public.claim_esign_webhook_receipt(
  uuid, uuid, text, text, text, text, text, text,
  timestamptz, jsonb, timestamptz, uuid, integer
)
  from public, anon, authenticated;
grant execute on function public.claim_esign_webhook_receipt(
  uuid, uuid, text, text, text, text, text, text,
  timestamptz, jsonb, timestamptz, uuid, integer
)
  to service_role;
revoke all on function public.complete_esign_webhook_receipt(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.complete_esign_webhook_receipt(
  uuid, uuid, text, text
) to service_role;

-- Keep duplicate-property maintenance aligned with the new dependents before
-- the legacy helper removes the loser property.
create or replace function public.merge_duplicate_properties(
  keeper_id uuid,
  loser_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keeper_org_id uuid;
  v_loser_org_id uuid;
begin
  select property.org_id into v_keeper_org_id
  from public.properties property where property.id = keeper_id;
  select property.org_id into v_loser_org_id
  from public.properties property where property.id = loser_id;
  if v_keeper_org_id is null or v_loser_org_id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found'
      using errcode = 'P0002';
  end if;
  if v_keeper_org_id <> v_loser_org_id
     or not public.hugo_has_active_org_access(v_keeper_org_id) then
    raise exception 'merge_duplicate_properties: active access required'
      using errcode = '42501';
  end if;

  update public.lead_events
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.ai_disposition_reviews
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.esign_requests
  set property_id = keeper_id,
      updated_at = now()
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.lead_files
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;

  perform public.merge_duplicate_properties_hugo_unchecked(keeper_id, loser_id);
end;
$$;

revoke all on function public.merge_duplicate_properties(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.merge_duplicate_properties(uuid, uuid)
  to authenticated;

-- Keep shared integration-test cleanup explicit for tables that do not
-- cascade from properties.
create or replace function public.reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  create temp table _memberships_snapshot on commit drop as
    select * from public.memberships;

  truncate table
    public.esign_webhook_receipts,
    public.lead_files,
    public.esign_request_signers,
    public.esign_requests,
    public.esign_templates,
    public.esign_template_staging_sources,
    public.org_esign_integrations,
    public.user_integration_prefs,
    public.user_oauth_tokens,
    public.call_recordings,
    public.call_transcripts,
    public.call_activities,
    public.dialer_batch_items,
    public.dialer_batches,
    public.dashboard_snapshots,
    public.metric_snapshots,
    public.memberships,
    public.task_reminder_deliveries,
    public.task_calendar_mutations,
    public.tasks,
    public.job_items,
    public.ai_response_claims,
    public.sms_inbound_deliveries,
    public.sms_inbound_intents,
    public.campaign_recipients,
    public.campaign_delivery_settings,
    public.campaigns,
    public.provider_sender_numbers,
    public.provider_campaigns,
    public.ai_disposition_reviews,
    public.message_threads,
    public.messages,
    public.consent_events,
    public.sms_phone_suppressions,
    public.property_merges,
    public.jobs,
    public.csv_imports,
    public.webhook_events,
    public.webhook_consumers,
    public.notifications,
    public.lead_events,
    public.lead_notes,
    public.sequence_step_runs,
    public.sequence_enrollments,
    public.sequence_steps,
    public.sequences,
    public.ai_responder_configs,
    public.property_lists,
    public.property_tags,
    public.tags,
    public.test_sms_log,
    public.closer_practice_outcomes,
    public.institute_course_outcomes,
    public.properties,
    public.homeowner_details,
    public.agent_details,
    public.contacts,
    public.cass_cache,
    public.skip_trace_cache
  restart identity cascade;

  delete from public.lists where coalesce(system_managed, false) = false;
  delete from public.sms_templates
  where coalesce(system_managed, false) = false and deleted_at is null;
  delete from public.saved_filters where coalesce(is_base, false) = false;

  insert into public.memberships
  select * from _memberships_snapshot
  where role = 'owner'
    and access_status = 'active'
    and deletion_prepared_at is null
    and access_expires_at is null
  order by org_id, user_id, id
  on conflict (user_id, org_id) do nothing;

  insert into public.memberships
  select * from _memberships_snapshot
  where role <> 'owner'
     or access_status <> 'active'
     or deletion_prepared_at is not null
     or access_expires_at is not null
  order by org_id, user_id, id
  on conflict (user_id, org_id) do nothing;
end;
$$;

revoke execute on function public.reset_tenant_tables() from public, authenticated;
grant execute on function public.reset_tenant_tables() to service_role;

commit;
