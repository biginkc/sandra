-- Forward-only eSign hardening for durable browser-upload reservations,
-- provider-create fencing, and explicit Dropbox Sign account identity.
-- The original 20260829194500 foundation is already present in persistent
-- test environments and must remain immutable.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Hosted Supabase service_role has BYPASSRLS, but it still needs function ACLs.
grant execute on function public.hugo_has_active_org_access(uuid)
  to service_role;

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
  if coalesce(auth.role(), '') <> 'service_role' then
    if not public.hugo_has_active_org_access(p_org_id) then
      raise exception 'active organization membership required'
        using errcode = '42501';
    end if;
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
  v_provider_account_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;
  select * into v_source from public.esign_templates template
  where template.id = p_source_template_id and template.org_id = p_org_id
    and template.lifecycle_state = 'finalized' and template.deleted_at is null
  for update;
  if not found then
    raise exception 'source eSign template not found' using errcode = 'P0002';
  end if;
  if v_source.provider_account_id is distinct from v_provider_account_id then
    raise exception 'source template provider account does not match current integration'
      using errcode = '23514';
  end if;
  insert into public.esign_templates (
    id, org_id, name, document_type, seller_role, signer_roles,
    merge_field_names, source_filename, source_size_bytes,
    source_content_type, source_sha256, provider_account_id, lifecycle_state,
    duplicate_of_template_id, created_by, updated_by
  ) values (
    v_id, p_org_id, p_name, v_source.document_type, v_source.seller_role,
    v_source.signer_roles, v_source.merge_field_names, v_source.source_filename,
    v_source.source_size_bytes, v_source.source_content_type,
    v_source.source_sha256, v_provider_account_id, 'preparing', v_source.id,
    p_actor_id, p_actor_id
  );
  return v_id;
end;
$$;

create or replace function public.create_esign_template_edit_revision(
  p_org_id uuid, p_source_template_id uuid, p_source_id uuid, p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
  v_source_template public.esign_templates%rowtype;
  v_source public.esign_template_staging_sources%rowtype;
  v_provider_account_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;

  select * into v_source_template
  from public.esign_templates template
  where template.id = p_source_template_id
    and template.org_id = p_org_id
    and template.lifecycle_state = 'finalized'
    and template.finalized_at is not null
    and template.deleted_at is null
    and template.sign_template_id is not null
  for update;
  if not found then
    raise exception 'active finalized eSign template not found'
      using errcode = 'P0002';
  end if;
  if v_source_template.provider_account_id is distinct from v_provider_account_id then
    raise exception 'source template provider account does not match current integration'
      using errcode = '23514';
  end if;

  select * into v_source
  from public.esign_template_staging_sources source
  where source.id = p_source_id
    and source.org_id = p_org_id
    and source.verification_state = 'verified'
    and source.cleanup_outcome = 'pending'
  for update;
  if not found then
    raise exception 'verified template edit source not found'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.esign_templates template
    where template.org_id = p_org_id
      and template.staging_source_id = p_source_id
  ) then
    raise exception 'verified template source is already attached'
      using errcode = '23505';
  end if;

  insert into public.esign_templates (
    id, org_id, name, document_type, seller_role, signer_roles,
    merge_field_names, staging_source_id, source_filename,
    source_size_bytes, source_content_type, source_sha256, staging_path,
    provider_account_id, lifecycle_state, supersedes_template_id,
    created_by, updated_by
  ) values (
    v_id, p_org_id, v_source_template.name, v_source_template.document_type,
    v_source_template.seller_role, v_source_template.signer_roles,
    v_source_template.merge_field_names, v_source.id, v_source.source_filename,
    v_source.source_size_bytes, v_source.content_type, v_source.source_sha256,
    v_source.storage_path, v_provider_account_id, 'preparing',
    v_source_template.id, p_actor_id, p_actor_id
  );
  return v_id;
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
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
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
  where source.id = p_source_id
  for update;
  if found then
    if v_existing.org_id = p_org_id
       and v_existing.storage_path = p_storage_path
       and v_existing.source_filename = p_source_filename
       and v_existing.source_size_bytes = p_source_size_bytes
       and v_existing.content_type = p_content_type
       and v_existing.source_sha256 = p_source_sha256
       and v_existing.cleanup_outcome = 'pending' then
      if v_existing.verification_state = 'prepared' then
        update public.esign_template_staging_sources source
        set verification_state = 'verified', verified_at = now()
        where source.id = p_source_id and source.org_id = p_org_id;
      end if;
      return v_existing.id;
    end if;
    raise exception 'verified template source metadata conflicts with the existing source'
      using errcode = '23505';
  end if;
  insert into public.esign_template_staging_sources (
    id, org_id, storage_path, source_filename, source_size_bytes,
    content_type, source_sha256, verification_state, prepared_at,
    verified_at, created_by
  ) values (
    p_source_id, p_org_id, p_storage_path, p_source_filename,
    p_source_size_bytes, p_content_type, p_source_sha256, 'verified', now(),
    now(), p_actor_id
  );
  return p_source_id;
end;
$$;

create or replace function public.consume_esign_template_source_draft(
  p_org_id uuid, p_source_id uuid, p_name text, p_document_type text,
  p_seller_role text, p_signer_roles jsonb, p_actor_id uuid
)
returns table (outcome text, template_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
  v_source public.esign_template_staging_sources%rowtype;
  v_existing public.esign_templates%rowtype;
  v_merge_fields constant text[] := array[
    'seller_name','property_address','offer_price','closing_date','earnest_money'
  ]::text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  perform 1
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;
  select * into v_source
  from public.esign_template_staging_sources source
  where source.id = p_source_id
  for update;
  if not found
     or v_source.org_id <> p_org_id
     or v_source.verification_state <> 'verified'
     or v_source.cleanup_outcome <> 'pending' then
    raise exception 'verified template source not found' using errcode = 'P0002';
  end if;

  select * into v_existing
  from public.esign_templates template
  where template.org_id = p_org_id and template.staging_source_id = p_source_id
  for update;
  if found then
    if v_existing.name = p_name
       and v_existing.document_type = p_document_type
       and v_existing.seller_role = p_seller_role
       and v_existing.signer_roles = p_signer_roles
       and v_existing.merge_field_names = v_merge_fields
       and v_existing.source_filename = v_source.source_filename
       and v_existing.source_size_bytes = v_source.source_size_bytes
       and v_existing.source_content_type = v_source.content_type
       and v_existing.source_sha256 = v_source.source_sha256
       and v_existing.staging_path = v_source.storage_path
       and v_existing.lifecycle_state = 'preparing'
       and v_existing.finalized_at is null
       and v_existing.deleted_at is null
       and v_existing.abandoned_at is null
       and v_existing.sign_template_id is null
       and v_existing.provider_account_id is null
       and v_existing.duplicate_of_template_id is null
       and v_existing.supersedes_template_id is null
       and v_existing.provider_create_state is not null then
      return query select 'existing_same_contract'::text, v_existing.id;
      return;
    end if;
    raise exception 'verified template source is attached to a conflicting draft'
      using errcode = '23505';
  end if;
  insert into public.esign_templates (
    id, org_id, name, document_type, seller_role, signer_roles,
    merge_field_names, staging_source_id, source_filename,
    source_size_bytes, source_content_type, source_sha256, staging_path,
    lifecycle_state, provider_create_state, created_by, updated_by
  ) values (
    v_id, p_org_id, p_name, p_document_type, p_seller_role, p_signer_roles,
    v_merge_fields,
    v_source.id, v_source.source_filename, v_source.source_size_bytes,
    v_source.content_type, v_source.source_sha256, v_source.storage_path,
    'preparing', 'unstarted', p_actor_id, p_actor_id
  );
  return query select 'created'::text, v_id;
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
declare v_template_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select consumed.template_id into v_template_id
  from public.consume_esign_template_source_draft(
    p_org_id, p_source_id, p_name, p_document_type,
    p_seller_role, p_signer_roles, p_actor_id
  ) consumed;
  return v_template_id;
end;
$$;

revoke all on function public.get_latest_esign_requests_for_properties(uuid, uuid[])
  from public, anon;
grant execute on function public.get_latest_esign_requests_for_properties(uuid, uuid[])
  to authenticated, service_role;

-- Account identity cannot be inferred from legacy encrypted credentials or a
-- template ID. Refuse an unsafe upgrade instead of silently relabeling rows.
do $$
begin
  if exists (select 1 from public.org_esign_integrations) then
    raise exception 'Disconnect legacy Dropbox Sign integrations before applying the account-identity migration.'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from public.esign_templates where sign_template_id is not null
  ) then
    raise exception 'Provider-attached eSign templates require explicit account reconciliation before migration.'
      using errcode = '55000';
  end if;
end;
$$;

alter table public.org_esign_integrations
  add column provider_account_id text;
alter table public.org_esign_integrations
  add constraint org_esign_integrations_provider_account_check check (
    provider_account_id = btrim(provider_account_id)
    and provider_account_id <> ''
  );
alter table public.org_esign_integrations
  alter column provider_account_id set not null;

alter table public.esign_template_staging_sources
  add column verification_state text not null default 'verified',
  add column prepared_at timestamptz not null default now(),
  add column cleanup_token uuid,
  add column cleanup_claimed_at timestamptz;
update public.esign_template_staging_sources
set prepared_at = created_at;
alter table public.esign_template_staging_sources
  alter column verified_at drop not null;
alter table public.esign_template_staging_sources
  drop constraint esign_template_staging_sources_cleanup_check;
alter table public.esign_template_staging_sources
  drop constraint esign_template_staging_sources_cleanup_outcome_check;
alter table public.esign_template_staging_sources
  add constraint esign_template_staging_sources_verification_state_check
    check (verification_state in ('prepared', 'verified')),
  add constraint esign_template_staging_sources_verification_check check (
    (verification_state = 'prepared' and verified_at is null)
    or (verification_state = 'verified' and verified_at is not null)
  ),
  add constraint esign_template_staging_sources_cleanup_outcome_check
    check (cleanup_outcome in ('pending', 'in_progress', 'deleted', 'failed')),
  add constraint esign_template_staging_sources_cleanup_check check (
    (cleanup_outcome = 'pending'
      and cleanup_token is null and cleanup_claimed_at is null
      and cleanup_attempted_at is null and cleanup_error_code is null)
    or (cleanup_outcome = 'in_progress'
      and cleanup_token is not null and cleanup_claimed_at is not null
      and cleanup_attempted_at is null and cleanup_error_code is null)
    or (cleanup_outcome = 'deleted'
      and cleanup_token is null and cleanup_claimed_at is null
      and cleanup_attempted_at is not null and cleanup_error_code is null)
    or (cleanup_outcome = 'failed'
      and cleanup_token is null and cleanup_claimed_at is null
      and cleanup_attempted_at is not null and cleanup_error_code is not null)
  );

comment on table public.esign_template_staging_sources is
  'Durable private-PDF upload reservations and service-attested sources. Browser-declared metadata is bound before upload; only server-observed object identity, bytes, MIME, PDF magic, and SHA-256 may transition a reservation to verified.';

create or replace function public.esign_staging_upload_is_reserved(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.esign_template_staging_sources source
    where source.storage_bucket = 'esign-staging'
      and source.storage_path = p_path
      and source.org_id = public.esign_storage_org_id(p_path)
      and (
        coalesce(auth.role(), '') = 'service_role'
        or public.esign_is_active_org_owner(source.org_id)
      )
      and source.verification_state in ('prepared', 'verified')
      and source.cleanup_outcome = 'pending'
  );
$$;

drop policy "esign_staging_owner_insert" on storage.objects;
create policy "esign_staging_owner_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'esign-staging'
    and public.esign_staging_path_is_valid(name)
    and public.esign_is_active_org_owner(public.esign_storage_org_id(name))
    and public.esign_staging_upload_is_reserved(name)
  );
revoke all on function public.esign_staging_upload_is_reserved(text)
  from public, anon, authenticated, service_role;
grant execute on function public.esign_staging_upload_is_reserved(text)
  to authenticated, service_role;

alter table public.esign_templates
  add column provider_account_id text,
  add column provider_create_state text,
  add column provider_create_claim_token_hash text,
  add column provider_create_last_released_token_hash text,
  add column provider_create_claimed_at timestamptz,
  add column provider_create_invocation_started_at timestamptz,
  add column provider_create_error_code text;
alter table public.esign_templates
  add constraint esign_templates_sign_template_id_check check (
    sign_template_id is null
    or (sign_template_id = btrim(sign_template_id) and sign_template_id <> '')
  ),
  add constraint esign_templates_provider_account_check check (
    provider_account_id is null
    or (provider_account_id = btrim(provider_account_id)
      and provider_account_id <> '')
  ),
  add constraint esign_templates_provider_create_state_check check (
    provider_create_state is null
    or provider_create_state in (
      'unstarted', 'claimed', 'invoking', 'unknown', 'attached'
    )
  ),
  add constraint esign_templates_provider_create_error_check check (
    provider_create_error_code is null
    or provider_create_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  add constraint esign_templates_provider_create_token_hash_check check (
    (provider_create_claim_token_hash is null
      or provider_create_claim_token_hash ~ '^[a-f0-9]{64}$')
    and (provider_create_last_released_token_hash is null
      or provider_create_last_released_token_hash ~ '^[a-f0-9]{64}$')
  ),
  add constraint esign_templates_provider_identity_check check (
    (sign_template_id is null and provider_account_id is null)
    or (sign_template_id is not null and provider_account_id is not null)
    or (
      sign_template_id is null
      and provider_account_id is not null
      and (
        provider_create_state in ('claimed', 'invoking', 'unknown')
        or duplicate_of_template_id is not null
        or supersedes_template_id is not null
      )
    )
  ),
  add constraint esign_templates_provider_create_check check (
    (provider_create_state is null
      and provider_create_claim_token_hash is null
      and provider_create_last_released_token_hash is null
      and provider_create_claimed_at is null
      and provider_create_invocation_started_at is null
      and provider_create_error_code is null)
    or (provider_create_state = 'unstarted'
      and provider_account_id is null
      and provider_create_claim_token_hash is null
      and provider_create_claimed_at is null
      and provider_create_invocation_started_at is null
      and provider_create_error_code is null)
    or (provider_create_state = 'claimed'
      and provider_account_id is not null
      and provider_create_claim_token_hash is not null
      and provider_create_last_released_token_hash is null
      and provider_create_claimed_at is not null
      and provider_create_invocation_started_at is null
      and provider_create_error_code is null)
    or (provider_create_state = 'invoking'
      and provider_account_id is not null
      and provider_create_claim_token_hash is not null
      and provider_create_last_released_token_hash is null
      and provider_create_claimed_at is not null
      and provider_create_invocation_started_at is not null
      and provider_create_error_code is null)
    or (provider_create_state = 'unknown'
      and provider_account_id is not null
      and provider_create_claim_token_hash is not null
      and provider_create_last_released_token_hash is null
      and provider_create_claimed_at is not null
      and provider_create_invocation_started_at is not null
      and provider_create_error_code is not null)
    or (provider_create_state = 'attached'
      and provider_account_id is not null
      and sign_template_id is not null
      and provider_create_claim_token_hash is not null
      and provider_create_last_released_token_hash is null
      and provider_create_claimed_at is not null
      and provider_create_invocation_started_at is not null
      and provider_create_error_code is null)
  ),
  add constraint esign_templates_provider_create_lineage_check check (
    provider_create_state is null
    or (
      staging_source_id is not null
      and duplicate_of_template_id is null
      and supersedes_template_id is null
    )
  );

drop index public.idx_esign_templates_provider_id;
create unique index idx_esign_templates_provider_id
  on public.esign_templates (provider_account_id, sign_template_id)
  where sign_template_id is not null;
create index idx_esign_template_staging_sources_recovery
  on public.esign_template_staging_sources (
    org_id, cleanup_outcome, created_at, id
  )
  where cleanup_outcome in ('pending', 'in_progress', 'failed');
create index idx_esign_templates_provider_create_recovery
  on public.esign_templates (
    org_id, provider_create_state, created_at, id
  )
  where provider_create_state in ('claimed', 'invoking', 'unknown')
    and finalized_at is null and deleted_at is null and abandoned_at is null;

create or replace function public.esign_template_is_available(
  p_template_id uuid, p_org_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (
    coalesce(auth.role(), '') = 'service_role'
    or public.hugo_has_active_org_access(p_org_id)
  ) and exists (
    select 1
    from public.esign_templates template
    join public.org_esign_integrations integration
      on integration.org_id = template.org_id
     and integration.provider = 'dropbox_sign'
     and integration.provider_account_id = template.provider_account_id
    where template.id = p_template_id
      and template.org_id = p_org_id
      and template.deleted_at is null
      and template.finalized_at is not null
  );
$$;
revoke all on function public.esign_template_is_available(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.esign_template_is_available(uuid, uuid)
  to authenticated, service_role;

drop view public.available_esign_templates;
create view public.available_esign_templates
with (security_invoker = true)
as
select
  template.id,
  template.org_id,
  template.name,
  template.document_type,
  template.seller_role,
  template.signer_roles,
  template.merge_field_names,
  template.sign_template_id,
  template.staging_source_id,
  template.source_filename,
  template.source_size_bytes,
  template.source_content_type,
  template.source_sha256,
  template.staging_path,
  template.staging_deleted_at,
  template.finalized_at,
  template.lifecycle_state,
  template.duplicate_of_template_id,
  template.supersedes_template_id,
  template.preparation_error_code,
  template.abandoned_by,
  template.abandoned_at,
  template.created_by,
  template.created_at,
  template.updated_by,
  template.updated_at,
  template.deleted_by,
  template.deleted_at
from public.esign_templates template
where template.deleted_at is null
  and template.finalized_at is not null
  and public.esign_template_is_available(template.id, template.org_id);
revoke all on table public.available_esign_templates
  from public, anon, authenticated, service_role;
grant select on table public.available_esign_templates to authenticated, service_role;

create or replace function public.prepare_esign_template_source_upload(
  p_org_id uuid, p_source_id uuid, p_source_filename text,
  p_source_size_bytes bigint, p_content_type text, p_source_sha256 text,
  p_actor_id uuid
)
returns table (
  outcome text,
  source_id uuid,
  storage_bucket text,
  storage_path text,
  verification_state text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.esign_template_staging_sources%rowtype;
  v_storage_path text := p_org_id::text || '/' || p_source_id::text || '.pdf';
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if p_content_type <> 'application/pdf'
     or p_source_size_bytes <= 0 or p_source_size_bytes > 41943040
     or p_source_sha256 !~ '^[a-f0-9]{64}$'
     or p_source_filename <> btrim(p_source_filename)
     or char_length(p_source_filename) not between 1 and 255
     or p_source_filename ~ '[\\/[:cntrl:]]' then
    raise exception 'template source reservation metadata is invalid'
      using errcode = '22023';
  end if;

  select * into v_existing
  from public.esign_template_staging_sources source
  where source.id = p_source_id
  for update;
  if found then
    if v_existing.org_id = p_org_id
       and v_existing.storage_bucket = 'esign-staging'
       and v_existing.storage_path = v_storage_path
       and v_existing.source_filename = p_source_filename
       and v_existing.source_size_bytes = p_source_size_bytes
       and v_existing.content_type = p_content_type
       and v_existing.source_sha256 = p_source_sha256
       and v_existing.cleanup_outcome = 'pending' then
      return query select 'existing_same_contract'::text, v_existing.id,
        v_existing.storage_bucket, v_existing.storage_path,
        v_existing.verification_state;
      return;
    end if;
    raise exception 'template source reservation conflicts with existing state'
      using errcode = '23505';
  end if;

  insert into public.esign_template_staging_sources (
    id, org_id, storage_path, source_filename, source_size_bytes,
    content_type, source_sha256, verification_state, prepared_at,
    verified_at, created_by
  ) values (
    p_source_id, p_org_id, v_storage_path, p_source_filename,
    p_source_size_bytes, p_content_type, p_source_sha256, 'prepared', now(),
    null, p_actor_id
  );

  return query select 'prepared'::text, p_source_id, 'esign-staging'::text,
    v_storage_path, 'prepared'::text;
end;
$$;

create or replace function public.verify_esign_template_source_upload(
  p_org_id uuid, p_source_id uuid, p_storage_path text,
  p_observed_size_bytes bigint, p_observed_content_type text,
  p_observed_sha256 text, p_actor_id uuid
)
returns table (outcome text, source_id uuid, verification_state text)
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_source public.esign_template_staging_sources%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_source
  from public.esign_template_staging_sources source
  where source.id = p_source_id
  for update;
  if not found
     or v_source.org_id <> p_org_id
     or v_source.storage_path <> p_storage_path then
    raise exception 'template source reservation not found' using errcode = 'P0002';
  end if;
  if v_source.cleanup_outcome <> 'pending' then
    raise exception 'template source reservation is being cleaned up'
      using errcode = '55000';
  end if;
  if p_observed_size_bytes <> v_source.source_size_bytes
     or p_observed_content_type <> v_source.content_type
     or p_observed_sha256 <> v_source.source_sha256 then
    raise exception 'observed template source metadata conflicts with reservation'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from storage.objects object
    where object.bucket_id = v_source.storage_bucket
      and object.name = v_source.storage_path
      and nullif(object.metadata ->> 'size', '')::bigint = p_observed_size_bytes
      and coalesce(object.metadata ->> 'mimetype', object.metadata ->> 'contentType')
        = p_observed_content_type
  ) then
    raise exception 'template source object does not match reservation'
      using errcode = '23514';
  end if;
  if v_source.verification_state = 'verified' then
    return query select 'already_verified'::text, v_source.id, 'verified'::text;
    return;
  end if;
  update public.esign_template_staging_sources source
  set verification_state = 'verified', verified_at = now()
  where source.id = p_source_id and source.org_id = p_org_id
    and source.verification_state = 'prepared';
  return query select 'verified'::text, v_source.id, 'verified'::text;
end;
$$;

create or replace function public.claim_esign_template_provider_create(
  p_org_id uuid, p_template_id uuid, p_source_id uuid, p_actor_id uuid
)
returns table (
  outcome text,
  template_id uuid,
  provider_create_state text,
  claim_token uuid,
  provider_template_id text,
  provider_account_id text,
  created_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template public.esign_templates%rowtype;
  v_token uuid;
  v_provider_account_id text;
  v_claimed_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;
  select * into v_template
  from public.esign_templates template
  where template.id = p_template_id
  for update;
  if not found
     or v_template.org_id <> p_org_id
     or v_template.staging_source_id <> p_source_id
     or v_template.duplicate_of_template_id is not null
     or v_template.supersedes_template_id is not null
     or v_template.lifecycle_state not in ('preparing', 'editing')
     or v_template.finalized_at is not null
     or v_template.deleted_at is not null
     or v_template.abandoned_at is not null
     or v_template.provider_create_state is null then
    raise exception 'ordinary eSign template draft claim contract does not match'
      using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.esign_template_staging_sources source
    where source.id = p_source_id
      and source.org_id = p_org_id
      and source.verification_state = 'verified'
      and source.cleanup_outcome = 'pending'
  ) then
    raise exception 'ordinary eSign template source is unavailable'
      using errcode = '55000';
  end if;
  if v_template.provider_create_state <> 'unstarted'
     and v_template.provider_account_id is distinct from v_provider_account_id then
    raise exception 'provider create account no longer matches current integration'
      using errcode = '23514';
  end if;
  if v_template.provider_create_state = 'attached' then
    return query select 'already_attached'::text, v_template.id,
      v_template.provider_create_state, null::uuid,
      v_template.sign_template_id, v_template.provider_account_id,
      v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state = 'claimed'
     and v_template.provider_create_claimed_at + interval '10 minutes'
       > v_claimed_at then
    return query select 'already_in_progress'::text, v_template.id,
      v_template.provider_create_state, null::uuid,
      null::text, v_template.provider_account_id, v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state in ('invoking', 'unknown') then
    return query select 'already_in_progress'::text, v_template.id,
      v_template.provider_create_state, null::uuid,
      null::text, v_template.provider_account_id, v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state = 'claimed' then
    v_token := gen_random_uuid();
    update public.esign_templates template
    set provider_create_claim_token_hash = encode(
          extensions.digest(
            convert_to(v_token::text, 'utf8'), 'sha256'
          ),
          'hex'
        ),
        provider_create_claimed_at = v_claimed_at,
        updated_by = p_actor_id,
        updated_at = v_claimed_at
    where template.id = p_template_id and template.org_id = p_org_id
      and template.provider_create_state = 'claimed'
      and template.provider_create_invocation_started_at is null;
    return query select 'claimed'::text, v_template.id, 'claimed'::text,
      v_token, null::text, v_template.provider_account_id,
      v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state <> 'unstarted' then
    raise exception 'ordinary eSign template provider state is invalid'
      using errcode = '23514';
  end if;
  v_token := gen_random_uuid();
  update public.esign_templates template
  set provider_create_state = 'claimed',
      provider_account_id = v_provider_account_id,
      provider_create_claim_token_hash = encode(
        extensions.digest(convert_to(v_token::text, 'utf8'), 'sha256'),
        'hex'
      ),
      provider_create_last_released_token_hash = null,
      provider_create_claimed_at = v_claimed_at,
      provider_create_invocation_started_at = null,
      provider_create_error_code = null,
      updated_by = p_actor_id,
      updated_at = v_claimed_at
  where template.id = p_template_id and template.org_id = p_org_id
    and template.provider_create_state = 'unstarted';
  if not found then
    raise exception 'ordinary eSign template provider claim changed concurrently'
      using errcode = '40001';
  end if;
  return query select 'claimed'::text, v_template.id, 'claimed'::text,
    v_token, null::text, v_provider_account_id, v_template.created_by;
end;
$$;

create or replace function public.begin_esign_template_provider_create(
  p_org_id uuid, p_template_id uuid, p_source_id uuid,
  p_claim_token uuid, p_actor_id uuid
)
returns table (
  outcome text,
  template_id uuid,
  provider_create_state text,
  created_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template public.esign_templates%rowtype;
  v_provider_account_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;
  select * into v_template from public.esign_templates template
  where template.id = p_template_id for update;
  if not found or v_template.org_id <> p_org_id
     or v_template.staging_source_id <> p_source_id
     or v_template.duplicate_of_template_id is not null
     or v_template.supersedes_template_id is not null then
    raise exception 'ordinary eSign template provider claim not found'
      using errcode = 'P0002';
  end if;
  if v_template.provider_account_id is distinct from v_provider_account_id then
    raise exception 'provider create account no longer matches current integration'
      using errcode = '23514';
  end if;
  if v_template.provider_create_state = 'attached' then
    return query select 'already_attached'::text, v_template.id,
      'attached'::text, v_template.created_by;
    return;
  end if;
  if v_template.provider_create_claim_token_hash is distinct from encode(
    extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
    'hex'
  ) then
    raise exception 'ordinary eSign template provider claim token does not match'
      using errcode = '42501';
  end if;
  if v_template.provider_create_state in ('invoking', 'unknown') then
    return query select 'already_started'::text, v_template.id,
      v_template.provider_create_state, v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state <> 'claimed' then
    raise exception 'ordinary eSign template provider claim is not startable'
      using errcode = '55000';
  end if;
  update public.esign_templates template
  set provider_create_state = 'invoking',
      provider_create_invocation_started_at = now(),
      updated_by = p_actor_id, updated_at = now()
  where template.id = p_template_id and template.org_id = p_org_id
    and template.provider_create_state = 'claimed'
    and template.provider_create_claim_token_hash = encode(
      extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
      'hex'
    );
  return query select 'started'::text, v_template.id, 'invoking'::text,
    v_template.created_by;
end;
$$;

create or replace function public.release_esign_template_provider_create_claim(
  p_org_id uuid, p_template_id uuid, p_source_id uuid,
  p_claim_token uuid, p_actor_id uuid
)
returns table (outcome text, template_id uuid, created_by uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_template public.esign_templates%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_template from public.esign_templates template
  where template.id = p_template_id for update;
  if not found or v_template.org_id <> p_org_id
     or v_template.staging_source_id <> p_source_id
     or v_template.duplicate_of_template_id is not null
     or v_template.supersedes_template_id is not null then
    raise exception 'ordinary eSign template provider claim not found'
      using errcode = 'P0002';
  end if;
  if v_template.provider_create_state = 'attached' then
    return query select 'already_attached'::text, v_template.id,
      v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state = 'unstarted'
     and v_template.provider_create_last_released_token_hash = encode(
       extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
       'hex'
     ) then
    return query select 'already_released'::text, v_template.id,
      v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state <> 'claimed'
     or v_template.provider_create_claim_token_hash is distinct from encode(
       extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
       'hex'
     ) then
    raise exception 'ordinary eSign template provider claim cannot be released'
      using errcode = '42501';
  end if;
  update public.esign_templates template
  set provider_create_state = 'unstarted',
      provider_account_id = null,
      provider_create_claim_token_hash = null,
      provider_create_last_released_token_hash = encode(
        extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
        'hex'
      ),
      provider_create_claimed_at = null,
      provider_create_invocation_started_at = null,
      provider_create_error_code = null,
      updated_by = p_actor_id, updated_at = now()
  where template.id = p_template_id and template.org_id = p_org_id
    and template.provider_create_state = 'claimed'
    and template.provider_create_claim_token_hash = encode(
      extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
      'hex'
    );
  return query select 'released'::text, v_template.id, v_template.created_by;
end;
$$;

create or replace function public.mark_esign_template_provider_create_unknown(
  p_org_id uuid, p_template_id uuid, p_source_id uuid,
  p_claim_token uuid, p_error_code text, p_actor_id uuid
)
returns table (outcome text, template_id uuid, created_by uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_template public.esign_templates%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if coalesce(p_error_code, '') !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'provider create unknown error code is invalid'
      using errcode = '22023';
  end if;
  select * into v_template from public.esign_templates template
  where template.id = p_template_id for update;
  if not found or v_template.org_id <> p_org_id
     or v_template.staging_source_id <> p_source_id
     or v_template.duplicate_of_template_id is not null
     or v_template.supersedes_template_id is not null then
    raise exception 'ordinary eSign template provider claim not found'
      using errcode = 'P0002';
  end if;
  if v_template.provider_create_state = 'attached' then
    return query select 'already_attached'::text, v_template.id,
      v_template.created_by;
    return;
  end if;
  if v_template.provider_create_claim_token_hash is distinct from encode(
    extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
    'hex'
  ) then
    raise exception 'ordinary eSign template provider claim token does not match'
      using errcode = '42501';
  end if;
  if v_template.provider_create_state = 'unknown' then
    return query select 'already_unknown'::text, v_template.id,
      v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state <> 'invoking' then
    raise exception 'ordinary eSign template provider call has not started'
      using errcode = '55000';
  end if;
  update public.esign_templates template
  set provider_create_state = 'unknown',
      provider_create_error_code = p_error_code,
      updated_by = p_actor_id, updated_at = now()
  where template.id = p_template_id and template.org_id = p_org_id
    and template.provider_create_state = 'invoking'
    and template.provider_create_claim_token_hash = encode(
      extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
      'hex'
    );
  return query select 'recorded_unknown'::text, v_template.id,
    v_template.created_by;
end;
$$;

create or replace function public.complete_esign_template_provider_create(
  p_org_id uuid, p_template_id uuid, p_source_id uuid,
  p_claim_token uuid, p_provider_template_id text, p_actor_id uuid
)
returns table (
  outcome text,
  template_id uuid,
  provider_template_id text,
  created_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_template public.esign_templates%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if btrim(coalesce(p_provider_template_id, '')) = ''
     or p_provider_template_id <> btrim(p_provider_template_id) then
    raise exception 'provider template ID is required' using errcode = '22023';
  end if;
  select * into v_template from public.esign_templates template
  where template.id = p_template_id for update;
  if not found or v_template.org_id <> p_org_id
     or v_template.staging_source_id <> p_source_id
     or v_template.duplicate_of_template_id is not null
     or v_template.supersedes_template_id is not null then
    raise exception 'ordinary eSign template provider claim not found'
      using errcode = 'P0002';
  end if;
  if v_template.provider_create_state = 'attached' then
    if v_template.provider_create_claim_token_hash = encode(
         extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
         'hex'
       )
       and v_template.sign_template_id = p_provider_template_id
       and v_template.provider_account_id is not null then
      return query select 'already_attached'::text, v_template.id,
        v_template.sign_template_id, v_template.created_by;
      return;
    end if;
    raise exception 'attached provider template identity conflicts with claim'
      using errcode = '23505';
  end if;
  if v_template.provider_create_state not in ('invoking', 'unknown')
     or v_template.provider_create_claim_token_hash is distinct from encode(
       extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
       'hex'
     )
     or v_template.provider_account_id is null then
    raise exception 'ordinary eSign template provider completion claim does not match'
      using errcode = '42501';
  end if;
  update public.esign_templates template
  set sign_template_id = p_provider_template_id,
      lifecycle_state = 'editing',
      provider_create_state = 'attached',
      provider_create_error_code = null,
      preparation_error_code = null,
      updated_by = p_actor_id, updated_at = now()
  where template.id = p_template_id and template.org_id = p_org_id
    and template.provider_create_state in ('invoking', 'unknown')
    and template.provider_create_claim_token_hash = encode(
      extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
      'hex'
    );
  return query select 'attached'::text, v_template.id,
    p_provider_template_id, v_template.created_by;
end;
$$;

create or replace function public.reconcile_unknown_esign_template_provider_create(
  p_org_id uuid, p_template_id uuid, p_source_id uuid,
  p_provider_template_id text, p_actor_id uuid
)
returns table (
  outcome text,
  template_id uuid,
  provider_template_id text,
  created_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template public.esign_templates%rowtype;
  v_provider_account_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if btrim(coalesce(p_provider_template_id, '')) = ''
     or p_provider_template_id <> btrim(p_provider_template_id) then
    raise exception 'provider template ID is required' using errcode = '22023';
  end if;
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;
  select * into v_template from public.esign_templates template
  where template.id = p_template_id for update;
  if not found or v_template.org_id <> p_org_id
     or v_template.staging_source_id <> p_source_id
     or v_template.duplicate_of_template_id is not null
     or v_template.supersedes_template_id is not null then
    raise exception 'ordinary eSign template unknown provider create not found'
      using errcode = 'P0002';
  end if;
  if v_template.provider_create_state = 'attached' then
    if v_template.sign_template_id = p_provider_template_id
       and v_template.provider_account_id = v_provider_account_id then
      return query select 'already_attached'::text, v_template.id,
        v_template.sign_template_id, v_template.created_by;
      return;
    end if;
    raise exception 'attached provider template identity conflicts with reconciliation'
      using errcode = '23505';
  end if;
  if v_template.provider_create_state <> 'unknown' then
    raise exception 'provider create is not awaiting manual reconciliation'
      using errcode = '55000';
  end if;
  if v_template.provider_account_id is distinct from v_provider_account_id then
    raise exception 'provider create account no longer matches current integration'
      using errcode = '23514';
  end if;
  update public.esign_templates template
  set sign_template_id = p_provider_template_id,
      lifecycle_state = 'editing',
      provider_create_state = 'attached',
      provider_create_error_code = null,
      preparation_error_code = null,
      updated_by = p_actor_id, updated_at = now()
  where template.id = p_template_id and template.org_id = p_org_id
    and template.provider_create_state = 'unknown';
  return query select 'attached'::text, v_template.id,
    p_provider_template_id, v_template.created_by;
end;
$$;

create or replace function public.list_pending_esign_template_provider_creates(
  p_org_id uuid, p_actor_id uuid
)
returns table (
  template_id uuid,
  source_id uuid,
  name text,
  provider_create_state text,
  provider_account_id text,
  provider_create_claimed_at timestamptz,
  provider_create_invocation_started_at timestamptz,
  provider_create_error_code text,
  created_by uuid,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  return query
  select template.id, template.staging_source_id, template.name,
    template.provider_create_state, template.provider_account_id,
    template.provider_create_claimed_at,
    template.provider_create_invocation_started_at,
    template.provider_create_error_code, template.created_by,
    template.created_at
  from public.esign_templates template
  where template.org_id = p_org_id
    and template.lifecycle_state in ('preparing', 'editing')
    and template.finalized_at is null
    and template.deleted_at is null
    and template.abandoned_at is null
    and template.duplicate_of_template_id is null
    and template.supersedes_template_id is null
    and template.provider_create_state in ('claimed', 'invoking', 'unknown')
  order by template.created_at, template.id;
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
  v_provider_account_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if btrim(coalesce(p_provider_template_id, '')) = ''
     or p_provider_template_id <> btrim(p_provider_template_id) then
    raise exception 'provider template ID is required' using errcode = '22023';
  end if;
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;
  select * into v_template from public.esign_templates template
  where template.id = p_template_id and template.org_id = p_org_id
  for update;
  if not found or v_template.deleted_at is not null
     or v_template.finalized_at is not null
     or v_template.lifecycle_state not in ('preparing', 'editing') then
    raise exception 'eSign template draft not found' using errcode = 'P0002';
  end if;
  if v_template.provider_create_state is not null then
    raise exception 'ordinary template provider creation requires a claim token'
      using errcode = '42501';
  end if;
  if v_template.provider_account_id is distinct from v_provider_account_id then
    raise exception 'template provider operation account does not match current integration'
      using errcode = '23514';
  end if;
  if v_template.staging_source_id is not null and not exists (
    select 1 from public.esign_template_staging_sources source
    where source.id = v_template.staging_source_id and source.org_id = p_org_id
      and source.verification_state = 'verified'
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
    sign_template_id = p_provider_template_id,
    lifecycle_state = 'editing',
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
  v_provider_account_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if btrim(coalesce(p_provider_template_id, '')) = ''
     or p_provider_template_id <> btrim(p_provider_template_id)
     or not public.esign_signer_roles_are_valid(p_seller_role, p_provider_signer_roles)
     or not public.esign_merge_fields_are_valid(p_provider_merge_field_names) then
    raise exception 'provider-reconciled template contract is invalid'
      using errcode = '23514';
  end if;
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;
  select * into v_template from public.esign_templates template
  where template.id = p_template_id and template.org_id = p_org_id
  for update;
  if not found or v_template.deleted_at is not null then
    raise exception 'eSign template draft not found' using errcode = 'P0002';
  end if;
  if v_template.supersedes_template_id is not null then
    raise exception 'edit revisions require atomic publish'
      using errcode = '55000';
  end if;
  if v_template.provider_account_id is distinct from v_provider_account_id then
    raise exception 'template provider account does not match current integration'
      using errcode = '23514';
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
    and lifecycle_state = 'editing' and sign_template_id = p_provider_template_id
    and provider_account_id = v_provider_account_id;
  if not found then
    raise exception 'eSign template draft changed before finalization'
      using errcode = '40001';
  end if;
  return 'finalized';
end;
$$;

create or replace function public.claim_unattached_esign_template_source_cleanup(
  p_org_id uuid, p_source_id uuid, p_storage_path text, p_actor_id uuid
)
returns table (
  outcome text,
  source_id uuid,
  cleanup_state text,
  cleanup_token uuid,
  cleanup_claimed_at timestamptz,
  created_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.esign_template_staging_sources%rowtype;
  v_token uuid;
  v_claimed_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_source
  from public.esign_template_staging_sources source
  where source.id = p_source_id
  for update;
  if not found
     or v_source.org_id <> p_org_id
     or v_source.storage_path <> p_storage_path then
    raise exception 'template source reservation not found'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.esign_templates template
    where template.org_id = p_org_id
      and template.staging_source_id = p_source_id
  ) then
    raise exception 'attached template source cannot be discarded'
      using errcode = '23514';
  end if;
  if v_source.cleanup_outcome = 'deleted' then
    return query select 'already_deleted'::text, v_source.id,
      'deleted'::text, null::uuid, null::timestamptz, v_source.created_by;
    return;
  end if;
  if v_source.cleanup_outcome = 'in_progress'
     and v_source.cleanup_claimed_at + interval '10 minutes' > v_claimed_at then
    return query select 'already_in_progress'::text, v_source.id,
      'in_progress'::text, null::uuid, v_source.cleanup_claimed_at,
      v_source.created_by;
    return;
  end if;
  if v_source.cleanup_outcome not in ('pending', 'failed', 'in_progress') then
    raise exception 'template source cleanup state is invalid'
      using errcode = '55000';
  end if;
  v_token := gen_random_uuid();
  update public.esign_template_staging_sources source
  set cleanup_outcome = 'in_progress',
      cleanup_token = v_token,
      cleanup_claimed_at = v_claimed_at,
      cleanup_attempted_at = null,
      cleanup_error_code = null
  where source.id = p_source_id and source.org_id = p_org_id;
  return query select 'claimed'::text, v_source.id, 'in_progress'::text,
    v_token, v_claimed_at, v_source.created_by;
end;
$$;

create or replace function public.complete_unattached_esign_template_source_cleanup(
  p_org_id uuid, p_source_id uuid, p_storage_path text,
  p_cleanup_token uuid, p_outcome text, p_safe_code text, p_actor_id uuid
)
returns table (
  outcome text,
  source_id uuid,
  cleanup_state text,
  created_by uuid
)
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_source public.esign_template_staging_sources%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if p_outcome not in ('deleted', 'failed')
     or (p_outcome = 'deleted' and p_safe_code is not null)
     or (p_outcome = 'failed'
       and coalesce(p_safe_code, '') !~ '^[A-Z][A-Z0-9_]{0,63}$') then
    raise exception 'template source cleanup result is invalid'
      using errcode = '22023';
  end if;
  select * into v_source
  from public.esign_template_staging_sources source
  where source.id = p_source_id
  for update;
  if not found
     or v_source.org_id <> p_org_id
     or v_source.storage_path <> p_storage_path then
    raise exception 'template source reservation not found'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.esign_templates template
    where template.org_id = p_org_id
      and template.staging_source_id = p_source_id
  ) then
    raise exception 'attached template source cannot be discarded'
      using errcode = '23514';
  end if;
  if v_source.cleanup_outcome = 'deleted' and p_outcome = 'deleted' then
    return query select 'already_deleted'::text, v_source.id,
      'deleted'::text, v_source.created_by;
    return;
  end if;
  if v_source.cleanup_outcome <> 'in_progress'
     or v_source.cleanup_token is distinct from p_cleanup_token then
    raise exception 'template source cleanup token does not match'
      using errcode = '42501';
  end if;
  if p_outcome = 'deleted' and exists (
    select 1 from storage.objects object
    where object.bucket_id = v_source.storage_bucket
      and object.name = v_source.storage_path
  ) then
    raise exception 'template source object still exists'
      using errcode = '23514';
  end if;
  update public.esign_template_staging_sources source
  set cleanup_outcome = p_outcome,
      cleanup_token = null,
      cleanup_claimed_at = null,
      cleanup_attempted_at = clock_timestamp(),
      cleanup_error_code = case when p_outcome = 'failed' then p_safe_code end
  where source.id = p_source_id and source.org_id = p_org_id
    and source.cleanup_outcome = 'in_progress'
    and source.cleanup_token = p_cleanup_token;
  return query select p_outcome, v_source.id, p_outcome, v_source.created_by;
end;
$$;

create or replace function public.list_pending_esign_template_source_uploads(
  p_org_id uuid, p_actor_id uuid
)
returns table (
  source_id uuid,
  storage_bucket text,
  storage_path text,
  source_filename text,
  source_size_bytes bigint,
  content_type text,
  source_sha256 text,
  verification_state text,
  cleanup_state text,
  prepared_at timestamptz,
  verified_at timestamptz,
  cleanup_claimed_at timestamptz,
  cleanup_attempted_at timestamptz,
  cleanup_error_code text,
  created_by uuid,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  return query
  select source.id, source.storage_bucket, source.storage_path,
    source.source_filename, source.source_size_bytes, source.content_type,
    source.source_sha256, source.verification_state, source.cleanup_outcome,
    source.prepared_at, source.verified_at, source.cleanup_claimed_at,
    source.cleanup_attempted_at, source.cleanup_error_code,
    source.created_by, source.created_at
  from public.esign_template_staging_sources source
  where source.org_id = p_org_id
    and source.cleanup_outcome in ('pending', 'in_progress', 'failed')
    and not exists (
      select 1 from public.esign_templates template
      where template.org_id = p_org_id
        and template.staging_source_id = source.id
    )
  order by source.created_at, source.id;
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
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_template from public.esign_templates template
  where template.id = p_template_id and template.org_id = p_org_id for update;
  if not found then
    raise exception 'eSign template draft not found' using errcode = 'P0002';
  end if;
  if v_template.lifecycle_state = 'abandoned' then
    return 'already_abandoned';
  end if;
  if v_template.provider_create_state in ('claimed', 'invoking', 'unknown') then
    raise exception 'resolve the provider create before abandoning this template'
      using errcode = '55000';
  end if;
  if v_template.finalized_at is not null or v_template.deleted_at is not null then
    raise exception 'only an unfinished eSign template draft can be abandoned'
      using errcode = '55000';
  end if;
  update public.esign_templates template
  set lifecycle_state = 'abandoned', abandoned_by = p_actor_id,
      abandoned_at = now(), updated_by = p_actor_id, updated_at = now()
  where template.id = p_template_id and template.org_id = p_org_id;
  return 'abandoned';
end;
$$;

create or replace function public.publish_esign_template_edit_revision(
  p_org_id uuid,
  p_source_template_id uuid,
  p_revision_template_id uuid,
  p_expected_source_provider_template_id text,
  p_revision_provider_template_id text,
  p_seller_role text,
  p_provider_signer_roles jsonb,
  p_provider_merge_field_names text[],
  p_actor_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_source_template public.esign_templates%rowtype;
  v_revision public.esign_templates%rowtype;
  v_provider_account_id text;
  v_published_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if p_source_template_id = p_revision_template_id
     or btrim(coalesce(p_expected_source_provider_template_id, '')) = ''
     or btrim(coalesce(p_revision_provider_template_id, '')) = ''
     or p_expected_source_provider_template_id = p_revision_provider_template_id
     or not public.esign_signer_roles_are_valid(
       p_seller_role, p_provider_signer_roles
     )
     or not public.esign_merge_fields_are_valid(
       p_provider_merge_field_names
     ) then
    raise exception 'provider-reconciled edit revision contract is invalid'
      using errcode = '23514';
  end if;
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;
  perform 1
  from public.esign_templates template
  where template.org_id = p_org_id
    and template.id in (p_source_template_id, p_revision_template_id)
  order by template.id
  for update;
  select * into v_source_template
  from public.esign_templates template
  where template.id = p_source_template_id and template.org_id = p_org_id;
  select * into v_revision
  from public.esign_templates template
  where template.id = p_revision_template_id and template.org_id = p_org_id;
  if v_source_template.id is null or v_revision.id is null then
    raise exception 'eSign template edit revision not found'
      using errcode = 'P0002';
  end if;
  if v_revision.lifecycle_state = 'finalized'
     and v_revision.finalized_at is not null
     and v_revision.deleted_at is null
     and v_revision.supersedes_template_id = p_source_template_id
     and v_revision.sign_template_id = p_revision_provider_template_id
     and v_revision.provider_account_id = v_provider_account_id
     and v_revision.seller_role = p_seller_role
     and v_revision.signer_roles = p_provider_signer_roles
     and public.esign_merge_fields_are_valid(v_revision.merge_field_names)
     and v_source_template.lifecycle_state = 'deleted'
     and v_source_template.deleted_at is not null
     and v_source_template.sign_template_id
       = p_expected_source_provider_template_id
     and v_source_template.provider_account_id = v_provider_account_id then
    return 'already_published';
  end if;
  if v_source_template.lifecycle_state <> 'finalized'
     or v_source_template.finalized_at is null
     or v_source_template.deleted_at is not null
     or v_source_template.sign_template_id
       is distinct from p_expected_source_provider_template_id
     or v_source_template.provider_account_id
       is distinct from v_provider_account_id then
    raise exception 'source eSign template is no longer active for this provider account'
      using errcode = '40001';
  end if;
  if v_revision.supersedes_template_id is distinct from p_source_template_id
     or v_revision.lifecycle_state <> 'editing'
     or v_revision.finalized_at is not null
     or v_revision.deleted_at is not null
     or v_revision.abandoned_at is not null
     or v_revision.sign_template_id
       is distinct from p_revision_provider_template_id
     or v_revision.provider_account_id is distinct from v_provider_account_id
     or v_revision.staging_source_id is null then
    raise exception 'hidden eSign template edit revision changed before publish'
      using errcode = '40001';
  end if;
  if not exists (
    select 1
    from public.esign_template_staging_sources source
    join storage.objects object
      on object.bucket_id = source.storage_bucket
     and object.name = source.storage_path
    where source.id = v_revision.staging_source_id
      and source.org_id = p_org_id
      and source.verification_state = 'verified'
      and source.cleanup_outcome = 'pending'
      and source.storage_path = v_revision.staging_path
      and source.source_filename = v_revision.source_filename
      and source.source_size_bytes = v_revision.source_size_bytes
      and source.content_type = v_revision.source_content_type
      and source.source_sha256 = v_revision.source_sha256
      and nullif(object.metadata ->> 'size', '')::bigint
        = source.source_size_bytes
      and coalesce(
        object.metadata ->> 'mimetype', object.metadata ->> 'contentType'
      ) = 'application/pdf'
  ) then
    raise exception 'verified template edit source is unavailable'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.esign_templates template
    where template.org_id = p_org_id
      and template.supersedes_template_id = p_source_template_id
      and template.id <> p_revision_template_id
      and template.finalized_at is not null
  ) then
    raise exception 'source eSign template already has a published successor'
      using errcode = '23505';
  end if;
  update public.esign_templates set
    seller_role = p_seller_role,
    signer_roles = p_provider_signer_roles,
    merge_field_names = p_provider_merge_field_names,
    finalized_at = v_published_at,
    lifecycle_state = 'finalized',
    preparation_error_code = null,
    updated_by = p_actor_id,
    updated_at = v_published_at
  where id = p_revision_template_id and org_id = p_org_id
    and lifecycle_state = 'editing' and finalized_at is null
    and deleted_at is null and abandoned_at is null
    and supersedes_template_id = p_source_template_id
    and sign_template_id = p_revision_provider_template_id
    and provider_account_id = v_provider_account_id;
  if not found then
    raise exception 'hidden eSign template edit revision changed before publish'
      using errcode = '40001';
  end if;
  update public.esign_templates set
    lifecycle_state = 'deleted', deleted_by = p_actor_id,
    deleted_at = v_published_at, updated_by = p_actor_id,
    updated_at = v_published_at
  where id = p_source_template_id and org_id = p_org_id
    and lifecycle_state = 'finalized' and finalized_at is not null
    and deleted_at is null
    and sign_template_id = p_expected_source_provider_template_id
    and provider_account_id = v_provider_account_id;
  if not found then
    raise exception 'source eSign template changed before publish'
      using errcode = '40001';
  end if;
  return 'published';
end;
$$;

drop function public.upsert_org_esign_integration(
  uuid, text, text, text, text, uuid, text
);
create function public.upsert_org_esign_integration(
  p_org_id uuid,
  p_api_key text,
  p_api_key_last_four text,
  p_client_id text,
  p_provider_account_id text,
  p_callback_secret_hash text,
  p_actor_id uuid,
  p_key text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_callback_consumer_id uuid := gen_random_uuid();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if btrim(coalesce(p_api_key, '')) = ''
     or btrim(coalesce(p_key, '')) = ''
     or btrim(coalesce(p_provider_account_id, '')) = ''
     or p_provider_account_id <> btrim(p_provider_account_id) then
    raise exception 'API key, encryption key, and provider account are required'
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
    'Dropbox Sign (' || p_org_id::text || ') ' || v_callback_consumer_id::text,
    p_callback_secret_hash, 'esign_provider', null, p_org_id, true, p_actor_id
  );
  insert into public.org_esign_integrations (
    org_id, api_key_encrypted, api_key_last_four, client_id,
    provider_account_id, callback_consumer_id, sending_enabled, test_mode,
    connected_by, updated_by
  ) values (
    p_org_id,
    extensions.pgp_sym_encrypt(p_api_key, p_key, 'cipher-algo=aes256'),
    p_api_key_last_four, p_client_id, p_provider_account_id,
    v_callback_consumer_id, false, true, p_actor_id, p_actor_id
  );
end;
$$;

drop function public.get_org_esign_credentials(uuid, text);
create function public.get_org_esign_credentials(p_org_id uuid, p_key text)
returns table (
  api_key text,
  client_id text,
  provider_account_id text,
  sending_enabled boolean,
  test_mode boolean,
  callback_secret_hash text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select extensions.pgp_sym_decrypt(integration.api_key_encrypted, p_key),
    integration.client_id, integration.provider_account_id,
    integration.sending_enabled, integration.test_mode, consumer.secret_hash
  from public.org_esign_integrations integration
  join public.webhook_consumers consumer
    on consumer.id = integration.callback_consumer_id
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
    and coalesce(auth.role(), '') = 'service_role';
$$;

create or replace function public.delete_org_esign_integration(
  p_org_id uuid, p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_callback_consumer_id uuid;
  v_blocker_count integer;
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
  select count(*) into v_blocker_count
  from public.esign_requests request
  where request.org_id = p_org_id
    and (
      request.status in ('awaiting', 'viewed')
      or request.delivery_state in ('sending', 'send_unknown')
      or (
        request.status = 'signed'
        and not exists (
          select 1 from public.lead_files file
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
  if v_blocker_count > 0 then
    raise exception 'Finish active signatures and save signed PDFs before disconnecting Dropbox Sign.'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.esign_templates template
    where template.org_id = p_org_id
      and template.provider_create_state in ('claimed', 'invoking', 'unknown')
  ) then
    raise exception 'Resolve the provider template operation before disconnecting Dropbox Sign.'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.esign_templates template
    where template.org_id = p_org_id
      and template.finalized_at is null
      and template.deleted_at is null
      and template.abandoned_at is null
  ) then
    raise exception 'Finish or abandon template setup before disconnecting Dropbox Sign.'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.esign_templates template
    join public.esign_template_staging_sources source
      on source.id = template.staging_source_id
     and source.org_id = template.org_id
    where template.org_id = p_org_id
      and source.cleanup_outcome in ('pending', 'in_progress', 'failed')
  ) then
    raise exception 'Finish attached template source cleanup before disconnecting Dropbox Sign.'
      using errcode = '23514';
  end if;
  delete from public.org_esign_integrations where org_id = p_org_id;
  update public.webhook_consumers
  set enabled = false, revoked_at = now(),
      secret_hash = encode(
        extensions.digest(convert_to(secret_hash || ':' || id::text, 'utf8'), 'sha256'),
        'hex'
      )
  where id = v_callback_consumer_id and consumer_type = 'esign_provider';
end;
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
  v_integration public.org_esign_integrations%rowtype;
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
  select * into v_integration
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for update;
  if not found or not v_integration.sending_enabled
     or not v_integration.test_mode then
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
    and template.provider_account_id = v_integration.provider_account_id
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
    select * into v_previous from public.esign_requests
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
      v_created_at, v_previous.created_at + interval '1 microsecond'
    );
  end if;
  insert into public.esign_requests (
    id, org_id, property_id, template_id, signer_snapshot,
    merge_value_snapshot, status, delivery_state, test_mode,
    send_intent_id, payload_hash, retry_of_request_id, created_by, created_at
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
  select p_org_id, v_id, signer.value ->> 'role', signer.position - 1,
    signer.value ->> 'name', signer.value ->> 'emailAddress'
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
  v_provider_account_id text;
  v_recent bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_template from public.esign_templates template
  where template.id = p_template_id and template.org_id = p_org_id
  for update;
  if not found then
    raise exception 'eSign template not found' using errcode = 'P0002';
  end if;
  select count(*) into v_recent from public.esign_requests request
  where request.org_id = p_org_id and request.template_id = p_template_id
    and request.created_at >= now() - interval '30 days';
  if v_template.deleted_at is not null then
    return query select 'already_deleted'::text, v_recent;
    return;
  end if;
  if v_template.finalized_at is null or v_template.sign_template_id is null then
    raise exception 'only a finalized eSign template can be deleted'
      using errcode = '55000';
  end if;
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found
     or v_template.provider_account_id is distinct from v_provider_account_id then
    raise exception 'template provider account does not match current integration'
      using errcode = '23514';
  end if;
  if v_recent > 0 and not p_confirm_recent_sends then
    return query select 'needs_confirmation'::text, v_recent;
    return;
  end if;
  update public.esign_templates
  set deleted_at = now(), deleted_by = p_actor_id,
      lifecycle_state = 'deleted', updated_at = now(), updated_by = p_actor_id
  where id = p_template_id and org_id = p_org_id and deleted_at is null
    and provider_account_id = v_provider_account_id;
  if not found then
    raise exception 'template changed before deletion' using errcode = '40001';
  end if;
  return query select 'deleted'::text, v_recent;
end;
$$;

revoke all on function public.get_latest_esign_requests_for_properties(uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_latest_esign_requests_for_properties(uuid, uuid[])
  to authenticated, service_role;

revoke all on function public.prepare_esign_template_source_upload(
  uuid, uuid, text, bigint, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_esign_template_source_upload(
  uuid, uuid, text, bigint, text, text, uuid
) to service_role;
revoke all on function public.verify_esign_template_source_upload(
  uuid, uuid, text, bigint, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.verify_esign_template_source_upload(
  uuid, uuid, text, bigint, text, text, uuid
) to service_role;
revoke all on function public.record_verified_esign_template_source(
  uuid, uuid, text, text, bigint, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.record_verified_esign_template_source(
  uuid, uuid, text, text, bigint, text, text, uuid
) to service_role;
revoke all on function public.consume_esign_template_source_draft(
  uuid, uuid, text, text, text, jsonb, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.consume_esign_template_source_draft(
  uuid, uuid, text, text, text, jsonb, uuid
) to service_role;
revoke all on function public.create_esign_template_draft(
  uuid, uuid, text, text, text, jsonb, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.create_esign_template_draft(
  uuid, uuid, text, text, text, jsonb, uuid
) to service_role;
revoke all on function public.claim_unattached_esign_template_source_cleanup(
  uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.claim_unattached_esign_template_source_cleanup(
  uuid, uuid, text, uuid
) to service_role;
revoke all on function public.complete_unattached_esign_template_source_cleanup(
  uuid, uuid, text, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.complete_unattached_esign_template_source_cleanup(
  uuid, uuid, text, uuid, text, text, uuid
) to service_role;
revoke all on function public.list_pending_esign_template_source_uploads(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_pending_esign_template_source_uploads(uuid, uuid)
  to service_role;
revoke all on function public.abandon_esign_template_draft(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.abandon_esign_template_draft(uuid, uuid, uuid)
  to service_role;

revoke all on function public.claim_esign_template_provider_create(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.claim_esign_template_provider_create(
  uuid, uuid, uuid, uuid
) to service_role;
revoke all on function public.begin_esign_template_provider_create(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.begin_esign_template_provider_create(
  uuid, uuid, uuid, uuid, uuid
) to service_role;
revoke all on function public.release_esign_template_provider_create_claim(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.release_esign_template_provider_create_claim(
  uuid, uuid, uuid, uuid, uuid
) to service_role;
revoke all on function public.mark_esign_template_provider_create_unknown(
  uuid, uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mark_esign_template_provider_create_unknown(
  uuid, uuid, uuid, uuid, text, uuid
) to service_role;
revoke all on function public.complete_esign_template_provider_create(
  uuid, uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.complete_esign_template_provider_create(
  uuid, uuid, uuid, uuid, text, uuid
) to service_role;
revoke all on function public.reconcile_unknown_esign_template_provider_create(
  uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_unknown_esign_template_provider_create(
  uuid, uuid, uuid, text, uuid
) to service_role;
revoke all on function public.list_pending_esign_template_provider_creates(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_pending_esign_template_provider_creates(uuid, uuid)
  to service_role;

revoke all on function public.create_esign_template_duplicate_draft(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_esign_template_duplicate_draft(uuid, uuid, text, uuid)
  to service_role;
revoke all on function public.create_esign_template_edit_revision(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_esign_template_edit_revision(uuid, uuid, uuid, uuid)
  to service_role;
revoke all on function public.attach_esign_template_provider_id(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attach_esign_template_provider_id(uuid, uuid, text, uuid)
  to service_role;
revoke all on function public.finalize_esign_template(
  uuid, uuid, text, text, jsonb, text[], uuid
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_esign_template(
  uuid, uuid, text, text, jsonb, text[], uuid
) to service_role;
revoke all on function public.publish_esign_template_edit_revision(
  uuid, uuid, uuid, text, text, text, jsonb, text[], uuid
) from public, anon, authenticated, service_role;
grant execute on function public.publish_esign_template_edit_revision(
  uuid, uuid, uuid, text, text, text, jsonb, text[], uuid
) to service_role;
revoke all on function public.soft_delete_esign_template(uuid, uuid, boolean, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.soft_delete_esign_template(uuid, uuid, boolean, uuid)
  to service_role;

revoke all on function public.create_esign_request(
  uuid, uuid, uuid, jsonb, jsonb, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.create_esign_request(
  uuid, uuid, uuid, jsonb, jsonb, uuid, text, uuid, uuid
) to service_role;

revoke all on function public.upsert_org_esign_integration(
  uuid, text, text, text, text, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.upsert_org_esign_integration(
  uuid, text, text, text, text, text, uuid, text
) to service_role;
revoke all on function public.get_org_esign_credentials(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_org_esign_credentials(uuid, text)
  to service_role;
revoke all on function public.delete_org_esign_integration(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_org_esign_integration(uuid, uuid)
  to service_role;

-- Preserve authenticated template reads without widening them to server-only
-- provider account, claim-digest, and recovery state added above.
revoke select on table public.esign_templates from authenticated;
grant select (
  id, org_id, name, document_type, seller_role, signer_roles,
  merge_field_names, sign_template_id, staging_source_id, source_filename,
  source_size_bytes, source_content_type, source_sha256, staging_path,
  staging_deleted_at, finalized_at, lifecycle_state,
  duplicate_of_template_id, supersedes_template_id, preparation_error_code,
  abandoned_by, abandoned_at, created_by, created_at, updated_by, updated_at,
  deleted_by, deleted_at
) on public.esign_templates to authenticated;

commit;
