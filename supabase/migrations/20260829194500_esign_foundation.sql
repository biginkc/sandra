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
  constraint org_esign_integrations_id_org_key unique (id, org_id)
);

comment on table public.org_esign_integrations is
  'Org-scoped Dropbox Sign v1 connection. API keys are pgcrypto ciphertext; browser-visible reads exclude the ciphertext column.';
comment on column public.org_esign_integrations.callback_consumer_id is
  'Dedicated esign_provider callback consumer. It stores only the callback path secret hash.';

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
      select count(distinct role.value ->> 'name')
      from jsonb_array_elements(p_roles) role(value)
    )
    and exists (
      select 1 from jsonb_array_elements(p_roles) role(value)
      where role.value ->> 'name' = p_seller_role
    );
$$;

create table public.esign_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  document_type text not null check (btrim(document_type) <> ''),
  seller_role text not null check (btrim(seller_role) <> ''),
  signer_roles jsonb not null check (
    public.esign_signer_roles_are_valid(seller_role, signer_roles)
  ),
  merge_field_names text[] not null check (
    merge_field_names = array[
      'seller_name', 'property_address', 'offer_price',
      'closing_date', 'earnest_money'
    ]::text[]
  ),
  sign_template_id text,
  source_filename text not null check (btrim(source_filename) <> ''),
  source_size_bytes bigint not null check (
    source_size_bytes > 0 and source_size_bytes <= 41943040
  ),
  staging_path text not null check (btrim(staging_path) <> ''),
  staging_deleted_at timestamptz,
  finalized_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  deleted_by uuid references auth.users(id),
  deleted_at timestamptz,
  constraint esign_templates_id_org_key unique (id, org_id),
  constraint esign_templates_finalized_provider_check check (
    finalized_at is null or sign_template_id is not null
  ),
  constraint esign_templates_staging_cleanup_check check (
    staging_deleted_at is null
    or finalized_at is not null
    or deleted_at is not null
  ),
  constraint esign_templates_delete_audit_check check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
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
  error_message text,
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
    (status in ('signed', 'declined', 'voided') and completed_at is not null)
    or (status not in ('signed', 'declined', 'voided'))
  ),
  constraint esign_requests_void_time_check check (
    void_requested_at is null
    or completed_at is null
    or void_requested_at <= completed_at
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
  )
);

create table public.lead_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  source_request_id uuid,
  file_name text not null check (btrim(file_name) <> ''),
  content_type text not null default 'application/pdf',
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
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
  constraint lead_files_storage_path_key unique (storage_bucket, storage_path)
);

comment on table public.lead_files is
  'Private lead artifact metadata. Signed PDFs live in the private lead-files Storage bucket.';

create unique index idx_esign_templates_provider_id
  on public.esign_templates (org_id, sign_template_id)
  where sign_template_id is not null;
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
  test_mode, connected_by, created_at, updated_by, updated_at
) on public.org_esign_integrations to authenticated;
grant all on table public.org_esign_integrations to service_role;

revoke all on table public.esign_templates
  from public, anon, authenticated, service_role;
grant select on table public.esign_templates to authenticated;
grant all on table public.esign_templates to service_role;
revoke all on table public.available_esign_templates
  from public, anon, authenticated, service_role;
grant select on table public.available_esign_templates to authenticated;
grant select on table public.available_esign_templates to service_role;

create or replace function public.create_esign_template_draft(
  p_org_id uuid,
  p_name text,
  p_document_type text,
  p_seller_role text,
  p_signer_roles jsonb,
  p_source_filename text,
  p_source_size_bytes bigint,
  p_staging_path text,
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
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

  insert into public.esign_templates (
    id, org_id, name, document_type, seller_role, signer_roles,
    merge_field_names, source_filename, source_size_bytes, staging_path,
    created_by, updated_by
  ) values (
    v_id, p_org_id, p_name, p_document_type, p_seller_role, p_signer_roles,
    array[
      'seller_name', 'property_address', 'offer_price',
      'closing_date', 'earnest_money'
    ]::text[],
    p_source_filename, p_source_size_bytes, p_staging_path,
    p_actor_id, p_actor_id
  );
  return v_id;
end;
$$;

create or replace function public.finalize_esign_template(
  p_org_id uuid,
  p_template_id uuid,
  p_provider_template_id text,
  p_seller_role text,
  p_provider_signer_roles jsonb,
  p_provider_merge_field_names text[],
  p_actor_id uuid
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
  if btrim(p_provider_template_id) = ''
     or not public.esign_signer_roles_are_valid(
       p_seller_role, p_provider_signer_roles
     )
     or p_provider_merge_field_names <> array[
       'seller_name', 'property_address', 'offer_price',
       'closing_date', 'earnest_money'
     ]::text[] then
    raise exception 'provider-reconciled template contract is invalid'
      using errcode = '23514';
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

  update public.esign_templates
  set sign_template_id = p_provider_template_id,
      seller_role = p_seller_role,
      signer_roles = p_provider_signer_roles,
      merge_field_names = p_provider_merge_field_names,
      finalized_at = now(),
      updated_by = p_actor_id,
      updated_at = now()
  where id = p_template_id and org_id = p_org_id and deleted_at is null;
  if not found then
    raise exception 'eSign template draft not found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.soft_delete_esign_template(
  p_org_id uuid,
  p_template_id uuid,
  p_actor_id uuid
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
  update public.esign_templates
  set deleted_at = now(), deleted_by = p_actor_id,
      updated_at = now(), updated_by = p_actor_id
  where id = p_template_id and org_id = p_org_id and deleted_at is null;
  if not found then
    raise exception 'eSign template not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.create_esign_template_draft(
  uuid, text, text, text, jsonb, text, bigint, text, uuid
) from public, anon, authenticated;
grant execute on function public.create_esign_template_draft(
  uuid, text, text, text, jsonb, text, bigint, text, uuid
) to service_role;
revoke all on function public.finalize_esign_template(
  uuid, uuid, text, text, jsonb, text[], uuid
) from public, anon, authenticated;
grant execute on function public.finalize_esign_template(
  uuid, uuid, text, text, jsonb, text[], uuid
) to service_role;
revoke all on function public.soft_delete_esign_template(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.soft_delete_esign_template(uuid, uuid, uuid)
  to service_role;

revoke all on table public.esign_requests
  from public, anon, authenticated, service_role;
grant select on table public.esign_requests to authenticated;
grant all on table public.esign_requests to service_role;

revoke all on table public.esign_request_signers
  from public, anon, authenticated, service_role;
grant select on table public.esign_request_signers to authenticated;
grant all on table public.esign_request_signers to service_role;

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
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
  v_roles jsonb;
  v_created_at timestamptz := clock_timestamp();
  v_previous public.esign_requests%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships membership
    where membership.org_id = p_org_id
      and membership.user_id = p_actor_id
      and membership.access_status = 'active'
      and membership.deletion_prepared_at is null
      and (membership.access_expires_at is null or membership.access_expires_at > now())
  ) then
    raise exception 'active organization membership required'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.org_esign_integrations integration
    where integration.org_id = p_org_id
      and integration.sending_enabled
      and integration.test_mode
  ) then
    raise exception 'Dropbox Sign is disconnected or sending is disabled'
      using errcode = '55000';
  end if;
  select template.signer_roles into v_roles
  from public.esign_templates template
  where template.id = p_template_id
    and template.org_id = p_org_id
    and template.deleted_at is null
    and template.finalized_at is not null
    and template.sign_template_id is not null;
  if not found then
    raise exception 'finalized eSign template not found' using errcode = 'P0002';
  end if;
  if not public.esign_request_payload_is_valid(
    p_signer_snapshot, p_merge_value_snapshot, v_roles
  ) then
    raise exception 'signers and merge values do not match the template'
      using errcode = '23514';
  end if;
  if p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'payload hash must be SHA-256 hex' using errcode = '22023';
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
      raise exception 'retry must reference a failed request for the same property and template'
        using errcode = '23514';
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
  );

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
  return v_id;
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
  if btrim(p_provider_request_id) = ''
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
    and signer.role_name = provided.value ->> 'role';

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
     or (p_delivery_state = 'failed' and btrim(coalesce(p_error_message, '')) = '') then
    raise exception 'invalid send outcome' using errcode = '23514';
  end if;
  update public.esign_requests
  set delivery_state = p_delivery_state,
      error_message = p_error_message,
      updated_at = now()
  where id = p_request_id and org_id = p_org_id and delivery_state = 'sending';
  if not found then
    raise exception 'eSign request is not sending' using errcode = '55000';
  end if;
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

revoke all on table public.lead_files
  from public, anon, authenticated, service_role;
grant select on table public.lead_files to authenticated;
grant all on table public.lead_files to service_role;

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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if btrim(p_api_key) = '' or btrim(p_key) = '' then
    raise exception 'API key and encryption key are required'
      using errcode = '22023';
  end if;

  insert into public.webhook_consumers (
    name, secret_hash, consumer_type, default_source, org_id, enabled,
    created_by
  ) values (
    'Dropbox Sign (' || p_org_id::text || ')',
    p_callback_secret_hash,
    'esign_provider',
    null,
    p_org_id,
    true,
    p_actor_id
  )
  on conflict (name) do update set
    secret_hash = excluded.secret_hash,
    enabled = true,
    revoked_at = null;

  insert into public.org_esign_integrations (
    org_id, api_key_encrypted, api_key_last_four, client_id,
    callback_consumer_id, sending_enabled, test_mode, connected_by, updated_by
  ) values (
    p_org_id,
    extensions.pgp_sym_encrypt(p_api_key, p_key, 'cipher-algo=aes256'),
    p_api_key_last_four,
    p_client_id,
    (select id from public.webhook_consumers
      where name = 'Dropbox Sign (' || p_org_id::text || ')'),
    false,
    true,
    p_actor_id,
    p_actor_id
  )
  on conflict (org_id, provider) do update set
    api_key_encrypted = excluded.api_key_encrypted,
    api_key_last_four = excluded.api_key_last_four,
    client_id = excluded.client_id,
    callback_consumer_id = excluded.callback_consumer_id,
    sending_enabled = false,
    test_mode = true,
    connected_by = excluded.connected_by,
    updated_by = excluded.updated_by,
    updated_at = now();
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

create or replace function public.delete_org_esign_integration(p_org_id uuid)
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

  select count(*) into v_pending_count
  from public.esign_requests request
  where request.org_id = p_org_id
    and (
      request.status in ('awaiting', 'viewed')
      or request.delivery_state in ('sending', 'send_unknown')
      or (request.status = 'signed' and request.signed_pdf_path is null)
    );
  if v_pending_count > 0 then
    raise exception 'Finish active signatures and save signed PDFs before disconnecting Dropbox Sign.'
      using errcode = '23514';
  end if;

  select callback_consumer_id into v_callback_consumer_id
  from public.org_esign_integrations where org_id = p_org_id;
  delete from public.org_esign_integrations where org_id = p_org_id;
  update public.webhook_consumers
  set enabled = false, revoked_at = now()
  where id = v_callback_consumer_id and consumer_type = 'esign_provider';
end;
$$;

revoke all on function public.delete_org_esign_integration(uuid)
  from public, anon, authenticated;
grant execute on function public.delete_org_esign_integration(uuid)
  to service_role;

insert into storage.buckets (id, name, public)
values
  ('esign-staging', 'esign-staging', false),
  ('lead-files', 'lead-files', false)
on conflict (id) do update set public = false;

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

create policy "esign_staging_owner_select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'esign-staging'
    and public.esign_is_active_org_owner(public.esign_storage_org_id(name))
  );
create policy "esign_staging_owner_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'esign-staging'
    and public.esign_is_active_org_owner(public.esign_storage_org_id(name))
  );
create policy "esign_staging_owner_update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'esign-staging'
    and public.esign_is_active_org_owner(public.esign_storage_org_id(name))
  )
  with check (
    bucket_id = 'esign-staging'
    and public.esign_is_active_org_owner(public.esign_storage_org_id(name))
  );
create policy "esign_staging_owner_delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'esign-staging'
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
create table public.esign_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  callback_consumer_id uuid not null,
  event_hash text not null,
  event_fingerprint text not null check (event_fingerprint ~ '^[a-f0-9]{64}$'),
  event_type text not null check (btrim(event_type) <> ''),
  sign_request_id text,
  related_signature_id text,
  provider_event_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  constraint esign_webhook_receipts_callback_consumer_org_fkey
    foreign key (callback_consumer_id, org_id)
    references public.webhook_consumers(id, org_id) on delete restrict,
  constraint esign_webhook_receipts_org_fingerprint_key
    unique (org_id, event_fingerprint)
);

comment on column public.esign_webhook_receipts.event_hash is
  'Dropbox authenticity HMAC. Deliberately not unique because its input omits request and signer identity.';
comment on column public.esign_webhook_receipts.event_fingerprint is
  'Org-scoped SHA-256 over event_hash plus request/signature identity and event type for idempotent processing.';

create index idx_esign_webhook_receipts_request
  on public.esign_webhook_receipts
  (org_id, sign_request_id, provider_event_at desc, received_at desc);
alter table public.esign_webhook_receipts enable row level security;
revoke all on table public.esign_webhook_receipts
  from public, anon, authenticated, service_role;
grant all on table public.esign_webhook_receipts to service_role;

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
  set property_id = keeper_id, updated_at = now()
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
    public.esign_requests,
    public.esign_templates,
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
