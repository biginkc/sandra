begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.org_esign_integrations
  drop constraint if exists org_esign_integrations_test_mode_check,
  add column if not exists live_send_monthly_limit integer not null default 40,
  add column if not exists live_send_monthly_used integer not null default 0,
  add column if not exists live_send_monthly_period_key text not null
    default to_char(now() at time zone 'America/Chicago', 'YYYY-MM'),
  add column if not exists live_send_monthly_period_started_at timestamptz
    not null default (
      date_trunc('month', now() at time zone 'America/Chicago')
        at time zone 'America/Chicago'
    ),
  drop constraint if exists org_esign_integrations_live_send_monthly_limit_check,
  add constraint org_esign_integrations_live_send_monthly_limit_check check (
    live_send_monthly_limit between 1 and 40
    and live_send_monthly_used between 0 and live_send_monthly_limit
    and live_send_monthly_period_key ~ '^[0-9]{4}-[0-9]{2}$'
  );

comment on column public.org_esign_integrations.test_mode is
  'Current request mode for new Dropbox Sign requests. Existing request rows snapshot their own immutable mode.';
comment on column public.org_esign_integrations.live_send_monthly_limit is
  'Sandra-owned live send ceiling. It cannot account for manual Dropbox Sign sends or other clients.';
comment on column public.org_esign_integrations.live_send_monthly_used is
  'Atomic Sandra live-send reservations in the current monthly period.';
comment on column public.org_esign_integrations.live_send_monthly_period_key is
  'America/Chicago YYYY-MM period for Sandra-owned live-send reservations.';

alter table public.esign_requests
  drop constraint if exists esign_requests_test_mode_check,
  add column if not exists live_send_reserved_at timestamptz,
  add column if not exists provider_remaining_at_claim integer,
  drop constraint if exists esign_requests_provider_remaining_at_claim_check,
  add constraint esign_requests_provider_remaining_at_claim_check check (
    provider_remaining_at_claim is null or provider_remaining_at_claim >= 0
  );

comment on column public.esign_requests.test_mode is
  'Immutable request-mode snapshot. Provider sends, retries, webhooks, reconciliation, and PDF handling must use this row value.';
comment on column public.esign_requests.provider_remaining_at_claim is
  'Dropbox Sign reported api_signature_requests_left at Sandra live-send reservation time.';

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

revoke all on function public.reject_esign_request_snapshot_change()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_esign_requests_created_at_immutable
  on public.esign_requests;
create trigger trg_esign_requests_created_at_immutable
  before update on public.esign_requests
  for each row execute function public.reject_esign_request_snapshot_change();

do $$
declare
  v_duplicate record;
begin
  select provider_account_id, sign_template_id, count(*) as duplicate_count,
    array_agg(id order by created_at, id) as template_ids
  into v_duplicate
  from public.esign_templates
  where provider_account_id is not null
    and sign_template_id is not null
  group by provider_account_id, sign_template_id
  having count(*) > 1
  limit 1;

  if found then
    raise exception
      'Duplicate eSign provider template pair blocks 20260902180000: provider_account_id %, sign_template_id %, template_ids %. Retire or reconcile duplicates before applying global provider template uniqueness.',
      v_duplicate.provider_account_id,
      v_duplicate.sign_template_id,
      v_duplicate.template_ids
      using errcode = '23505';
  end if;
end;
$$;

alter table public.esign_templates
  add column if not exists template_origin text not null default 'sandra_embedded',
  add column if not exists provider_metadata jsonb,
  add column if not exists provider_metadata_attested_at timestamptz,
  add column if not exists provider_metadata_unavailable_at timestamptz,
  add column if not exists provider_metadata_unavailable_reason text,
  drop constraint if exists esign_templates_template_origin_check,
  add constraint esign_templates_template_origin_check check (
    template_origin in ('sandra_embedded', 'dropbox_website')
  ),
  drop constraint if exists esign_templates_provider_metadata_check,
  add constraint esign_templates_provider_metadata_check check (
    (
      template_origin = 'sandra_embedded'
      and provider_metadata is null
      and provider_metadata_attested_at is null
      and provider_metadata_unavailable_at is null
      and provider_metadata_unavailable_reason is null
    )
    or (
      template_origin = 'dropbox_website'
      and staging_source_id is null
      and source_filename is null
      and source_size_bytes is null
      and source_content_type is null
      and source_sha256 is null
      and staging_path is null
      and staging_deleted_at is null
      and duplicate_of_template_id is null
      and supersedes_template_id is null
      and provider_account_id is not null
      and sign_template_id is not null
      and finalized_at is not null
      and lifecycle_state = 'finalized'
      and jsonb_typeof(provider_metadata) = 'object'
      and provider_metadata_attested_at is not null
      and (
        provider_metadata_unavailable_at is null
        or provider_metadata_unavailable_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'
      )
    )
  ),
  drop constraint if exists esign_templates_source_snapshot_check,
  add constraint esign_templates_source_snapshot_check check (
    (
      template_origin = 'sandra_embedded'
      and (
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
          and supersedes_template_id is null
          and staging_path is null
        )
      )
    )
    or template_origin = 'dropbox_website'
  );

comment on column public.esign_templates.template_origin is
  'sandra_embedded rows were created by Sandra embedded-template tooling; dropbox_website rows are owner-registered non-embedded templates created in Dropbox Sign.';
comment on column public.esign_templates.provider_metadata is
  'Server-attested Dropbox Sign template metadata captured by templateGet for website-created templates.';

drop index if exists public.idx_esign_templates_provider_id;
create unique index idx_esign_templates_provider_id
  on public.esign_templates (provider_account_id, sign_template_id)
  where sign_template_id is not null;

drop function if exists public.esign_website_template_metadata_is_valid(text, jsonb);

create or replace function public.esign_website_template_metadata_is_valid(
  p_provider_template_id text,
  p_provider_account_id text,
  p_metadata jsonb
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  with documents as (
    select document.value as document
    from jsonb_array_elements(
      case
        when jsonb_typeof(p_metadata -> 'documents') = 'array'
          then p_metadata -> 'documents'
        else '[]'::jsonb
      end
    ) document(value)
  ),
  custom_fields as (
    select field.value as field
    from documents
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(documents.document -> 'customFields') = 'array'
          then documents.document -> 'customFields'
        else '[]'::jsonb
      end
    ) field(value)
    where field.value ->> 'name' in (
      'seller_name',
      'property_address',
      'offer_price',
      'earnest_money',
      'closing_date'
    )
  ),
  sender_custom_fields as (
    select field.value as field
    from documents
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(documents.document -> 'customFields') = 'array'
          then documents.document -> 'customFields'
        else '[]'::jsonb
      end
    ) field(value)
    where field.value ->> 'assignedTo' = 'sender'
  ),
  sender_merge_fields as (
    select field
    from sender_custom_fields
    where field ->> 'assignedTo' = 'sender'
      and field ->> 'type' = 'text'
      and btrim(coalesce(field ->> 'apiId', '')) <> ''
      and field ->> 'name' in (
        'seller_name',
        'property_address',
        'offer_price',
        'earnest_money',
        'closing_date'
      )
  ),
  all_required_signature_fields as (
    select field.value as field,
      field.value ->> 'signerRoleName' as role_name
    from documents
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(documents.document -> 'formFields') = 'array'
          then documents.document -> 'formFields'
        else '[]'::jsonb
      end
    ) field(value)
    where field.value ->> 'type' = 'signature'
      and field.value -> 'required' = 'true'::jsonb
  ),
  required_signature_fields as (
    select role_name
    from all_required_signature_fields
    where field ->> 'assignedTo' = 'signer'
      and btrim(coalesce(field ->> 'apiId', '')) <> ''
      and field ->> 'signerRoleName' in ('Seller', 'Buyer')
  )
  select btrim(coalesce(p_provider_template_id, '')) <> ''
    and btrim(coalesce(p_provider_account_id, '')) <> ''
    and jsonb_typeof(p_metadata) = 'object'
    and p_metadata ->> 'providerTemplateId' = p_provider_template_id
    and p_metadata -> 'isEmbedded' = 'false'::jsonb
    and p_metadata -> 'isLocked' = 'false'::jsonb
    and exists (
      select 1
      from jsonb_array_elements(
        case
          when jsonb_typeof(p_metadata -> 'accounts') = 'array'
            then p_metadata -> 'accounts'
          else '[]'::jsonb
        end
      ) account(value)
      where account.value ->> 'accountId' = p_provider_account_id
    )
    and p_metadata -> 'signerRoles' =
      jsonb_build_array(
        jsonb_build_object('name', 'Seller', 'order', 0),
        jsonb_build_object('name', 'Buyer', 'order', 1)
      )
    and exists (select 1 from documents)
    and (
      select count(*) from custom_fields
    ) = 5
    and (
      select count(*) from sender_custom_fields
    ) = 5
    and (
      select array_agg(field ->> 'name' order by field ->> 'name')
      from sender_merge_fields
    ) = array[
      'closing_date',
      'earnest_money',
      'offer_price',
      'property_address',
      'seller_name'
    ]::text[]
    and (
      select count(*) from sender_merge_fields
    ) = 5
    and not exists (
      select 1
      from all_required_signature_fields
      where field ->> 'assignedTo' is distinct from 'signer'
        or role_name is null
        or role_name not in ('Seller', 'Buyer')
    )
    and exists (
      select 1 from required_signature_fields where role_name = 'Seller'
    )
    and exists (
      select 1 from required_signature_fields where role_name = 'Buyer'
    );
$$;

revoke all on function public.esign_website_template_metadata_is_valid(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.esign_website_template_metadata_is_valid(text, text, jsonb)
  to service_role;

grant select (
  live_send_monthly_limit,
  live_send_monthly_used,
  live_send_monthly_period_key,
  live_send_monthly_period_started_at
) on public.org_esign_integrations to authenticated;

create or replace function public.esign_template_is_available(
  p_template_id uuid,
  p_org_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.esign_templates template
    join public.org_esign_integrations integration
      on integration.org_id = template.org_id
     and integration.provider = 'dropbox_sign'
     and integration.provider_account_id = template.provider_account_id
    join public.webhook_consumers consumer
      on consumer.id = integration.callback_consumer_id
     and consumer.org_id = integration.org_id
    where template.id = p_template_id
      and template.org_id = p_org_id
      and template.lifecycle_state = 'finalized'
      and template.deleted_at is null
      and template.finalized_at is not null
      and template.sign_template_id is not null
      and template.provider_metadata_unavailable_at is null
      and (
        template.template_origin = 'sandra_embedded'
        or (
          template.provider_metadata_attested_at >= now() - interval '30 days'
          and public.esign_website_template_metadata_is_valid(
            template.sign_template_id,
            template.provider_account_id,
            template.provider_metadata
          )
        )
      )
      and integration.api_key_encrypted is not null
      and integration.api_key_last_four is not null
      and integration.client_id is not null
      and integration.provider_account_id is not null
      and integration.disconnect_pending_at is null
      and integration.disconnect_requested_by is null
      and consumer.consumer_type = 'esign_provider'
      and consumer.enabled
      and consumer.revoked_at is null
      and (
        coalesce(auth.role(), '') = 'service_role'
        or public.hugo_has_active_org_access(p_org_id)
      )
  );
$$;

revoke all on function public.esign_template_is_available(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.esign_template_is_available(uuid, uuid)
  to authenticated, service_role;

drop view if exists public.available_esign_templates;
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
  template.template_origin,
  template.provider_metadata,
  template.provider_metadata_attested_at,
  template.provider_metadata_unavailable_at,
  template.provider_metadata_unavailable_reason,
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

create or replace function public.register_dropbox_website_esign_template(
  p_org_id uuid,
  p_actor_id uuid,
  p_provider_template_id text,
  p_name text,
  p_document_type text,
  p_provider_account_id text,
  p_provider_metadata jsonb
)
returns table (outcome text, template_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_integration public.org_esign_integrations%rowtype;
  v_existing public.esign_templates%rowtype;
  v_template_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if not public.esign_website_template_metadata_is_valid(
    p_provider_template_id, p_provider_account_id, p_provider_metadata
  ) then
    raise exception 'Dropbox Sign template metadata does not match Sandra eSign requirements'
      using errcode = '23514';
  end if;
  select * into v_integration
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for update;
  if not found
     or v_integration.disconnect_pending_at is not null
     or v_integration.api_key_encrypted is null
     or v_integration.provider_account_id is null then
    raise exception 'Dropbox Sign is not connected' using errcode = 'P0002';
  end if;
  if v_integration.provider_account_id <> p_provider_account_id then
    raise exception 'Dropbox Sign template belongs to a different provider account'
      using errcode = '23514';
  end if;
  insert into public.esign_templates (
    org_id, name, document_type, seller_role, signer_roles, merge_field_names,
    sign_template_id, provider_account_id, template_origin, provider_metadata,
    provider_metadata_attested_at, finalized_at, lifecycle_state,
    created_by, updated_by
  ) values (
    p_org_id, btrim(p_name), btrim(p_document_type), 'Seller',
    jsonb_build_array(
      jsonb_build_object('name', 'Seller', 'order', 0),
      jsonb_build_object('name', 'Buyer', 'order', 1)
    ),
    array[
      'seller_name',
      'property_address',
      'offer_price',
      'closing_date',
      'earnest_money'
    ]::text[],
    p_provider_template_id, p_provider_account_id, 'dropbox_website',
    p_provider_metadata, now(), now(), 'finalized', p_actor_id, p_actor_id
  )
  on conflict (provider_account_id, sign_template_id)
    where sign_template_id is not null
  do nothing
  returning id into v_template_id;
  if found then
    return query select 'registered'::text, v_template_id;
    return;
  end if;

  select * into v_existing
  from public.esign_templates template
  where template.provider_account_id = p_provider_account_id
    and template.sign_template_id = p_provider_template_id
  for update;
  if not found then
    raise exception 'Dropbox Sign template registration conflict was not readable'
      using errcode = '40001';
  end if;
  if v_existing.org_id <> p_org_id then
    raise exception 'Dropbox Sign template is already registered to another organization'
      using errcode = '23514';
  end if;
  if v_existing.template_origin <> 'dropbox_website' then
    raise exception 'Dropbox Sign template is already managed by Sandra embedded tooling'
      using errcode = '23514';
  end if;
  update public.esign_templates
  set name = btrim(p_name),
      document_type = btrim(p_document_type),
      deleted_at = null,
      deleted_by = null,
      provider_metadata = p_provider_metadata,
      provider_metadata_attested_at = now(),
      provider_metadata_unavailable_at = null,
      provider_metadata_unavailable_reason = null,
      updated_by = p_actor_id,
      updated_at = now()
  where id = v_existing.id
    and org_id = p_org_id;
  return query select
    case when v_existing.deleted_at is null then 'existing' else 'restored' end,
    v_existing.id;
end;
$$;

revoke all on function public.register_dropbox_website_esign_template(
  uuid, uuid, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.register_dropbox_website_esign_template(
  uuid, uuid, text, text, text, text, jsonb
) to service_role;

create or replace function public.mark_dropbox_website_esign_template_unavailable(
  p_org_id uuid,
  p_actor_id uuid,
  p_template_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_integration public.org_esign_integrations%rowtype;
  v_template public.esign_templates%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if p_reason !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'invalid unavailable reason' using errcode = '22023';
  end if;
  select * into v_integration
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for update;
  if not found or v_integration.provider_account_id is null then
    raise exception 'Dropbox Sign is not connected' using errcode = 'P0002';
  end if;
  select * into v_template
  from public.esign_templates template
  where template.id = p_template_id
    and template.org_id = p_org_id
    and template.template_origin = 'dropbox_website'
    and template.provider_account_id = v_integration.provider_account_id
    and template.deleted_at is null
  for update;
  if not found then
    raise exception 'Dropbox website template not found' using errcode = 'P0002';
  end if;
  update public.esign_templates
  set provider_metadata_unavailable_at = now(),
      provider_metadata_unavailable_reason = p_reason,
      updated_by = p_actor_id,
      updated_at = now()
  where id = p_template_id
    and org_id = p_org_id;
end;
$$;

revoke all on function public.mark_dropbox_website_esign_template_unavailable(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.mark_dropbox_website_esign_template_unavailable(
  uuid, uuid, uuid, text
) to service_role;

drop function if exists public.mark_dropbox_website_esign_template_unavailable(
  uuid, uuid, uuid, text, text
);

create or replace function public.set_org_esign_test_mode(
  p_org_id uuid,
  p_actor_id uuid,
  p_test_mode boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_integration public.org_esign_integrations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_integration
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for update;
  if not found then
    raise exception 'Dropbox Sign is not connected' using errcode = 'P0002';
  end if;
  update public.org_esign_integrations
  set test_mode = p_test_mode,
      sending_enabled = false,
      updated_by = p_actor_id,
      updated_at = now()
  where org_id = p_org_id
    and provider = 'dropbox_sign';
end;
$$;

revoke all on function public.set_org_esign_test_mode(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_org_esign_test_mode(uuid, uuid, boolean)
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
declare
  v_integration public.org_esign_integrations%rowtype;
  v_available_templates integer;
  v_current_period_key text := to_char(now() at time zone 'America/Chicago', 'YYYY-MM');
  v_current_period_started_at timestamptz :=
    (
      date_trunc('month', now() at time zone 'America/Chicago')
        at time zone 'America/Chicago'
    );
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select * into v_integration
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for update;
  if not found then
    raise exception 'Dropbox Sign is not connected' using errcode = 'P0002';
  end if;
  if not v_integration.test_mode
     and v_integration.live_send_monthly_period_key <> v_current_period_key then
    update public.org_esign_integrations
    set live_send_monthly_used = 0,
        live_send_monthly_period_key = v_current_period_key,
        live_send_monthly_period_started_at = v_current_period_started_at,
        updated_by = p_actor_id,
        updated_at = now()
    where org_id = p_org_id
      and provider = 'dropbox_sign';
    v_integration.live_send_monthly_used := 0;
    v_integration.live_send_monthly_period_key := v_current_period_key;
    v_integration.live_send_monthly_period_started_at := v_current_period_started_at;
  end if;
  if v_integration.disconnect_pending_at is not null then
    raise exception 'Finish active eSign work before re-enabling Dropbox Sign sending'
      using errcode = '23514';
  end if;
  if p_enabled and (
    v_integration.callback_verified_at is null
    or v_integration.api_key_encrypted is null
    or v_integration.api_key_last_four is null
    or v_integration.client_id is null
    or v_integration.provider_account_id is null
  ) then
    raise exception 'Verify the Dropbox Sign callback before enabling sending'
      using errcode = '23514';
  end if;
  if p_enabled and not v_integration.test_mode then
    if v_integration.live_send_monthly_used >= v_integration.live_send_monthly_limit then
      raise exception 'Sandra live-send monthly limit has been reached'
        using errcode = '23514';
    end if;
    select count(*)::integer into v_available_templates
    from public.esign_templates template
    where template.org_id = p_org_id
      and template.template_origin = 'dropbox_website'
      and template.deleted_at is null
      and template.finalized_at is not null
      and template.provider_metadata_attested_at >= now() - interval '30 days'
      and template.provider_metadata_unavailable_at is null
      and public.esign_website_template_metadata_is_valid(
        template.sign_template_id,
        template.provider_account_id,
        template.provider_metadata
      )
      and public.esign_template_is_available(template.id, p_org_id);
    if v_available_templates = 0 then
      raise exception 'Register a Dropbox Sign website template before enabling live sending'
        using errcode = '23514';
    end if;
  end if;
  update public.org_esign_integrations
  set sending_enabled = p_enabled,
      updated_by = p_actor_id,
      updated_at = now()
  where org_id = p_org_id
    and provider = 'dropbox_sign';
end;
$$;

revoke all on function public.set_org_esign_sending_enabled(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_org_esign_sending_enabled(uuid, uuid, boolean)
  to service_role;

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
  v_homeowner_contact public.contacts%rowtype;
  v_homeowner_contact_id uuid;
  v_submitted_seller_email text;
  v_request_test_mode boolean;
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
      null::public.esign_delivery_state, null::boolean, null::timestamptz;
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
  if not found or not v_integration.sending_enabled then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'ESIGN_SENDING_UNAVAILABLE'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state,
      null::boolean, null::timestamptz;
    return;
  end if;
  v_request_test_mode := v_integration.test_mode;
  select * into v_template
  from public.esign_templates template
  where template.id = p_template_id
    and template.org_id = p_org_id
    and template.deleted_at is null
    and template.finalized_at is not null
    and template.sign_template_id is not null
    and template.provider_account_id = v_integration.provider_account_id
    and public.esign_template_is_available(template.id, p_org_id)
    and (
      v_request_test_mode
      or (
        template.template_origin = 'dropbox_website'
        and template.provider_metadata_attested_at >= now() - interval '30 days'
        and template.provider_metadata_unavailable_at is null
        and public.esign_website_template_metadata_is_valid(
          template.sign_template_id,
          template.provider_account_id,
          template.provider_metadata
        )
      )
    )
  for update;
  if not found then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'FINALIZED_TEMPLATE_NOT_FOUND'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, v_request_test_mode, null::timestamptz;
    return;
  end if;
  select property.homeowner_contact_id into v_homeowner_contact_id
  from public.properties property
  where property.id = p_property_id and property.org_id = p_org_id;
  if not found then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'PROPERTY_NOT_FOUND'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, v_request_test_mode, null::timestamptz;
    return;
  end if;
  if v_homeowner_contact_id is null then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'MISSING_HOMEOWNER_CONTACT'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, v_request_test_mode, null::timestamptz;
    return;
  end if;
  select * into v_homeowner_contact from public.contacts contact
  where contact.id = v_homeowner_contact_id and contact.org_id = p_org_id
  for update;
  if not found then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'MISSING_HOMEOWNER_CONTACT'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, v_request_test_mode, null::timestamptz;
    return;
  end if;
  select * into v_property from public.properties property
  where property.id = p_property_id and property.org_id = p_org_id
  for update;
  if not found or v_property.homeowner_contact_id is distinct from v_homeowner_contact_id then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'PROPERTY_NOT_FOUND'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, v_request_test_mode, null::timestamptz;
    return;
  end if;
  if not public.esign_request_payload_is_valid(
    p_signer_snapshot, p_merge_value_snapshot, v_template.signer_roles
  ) then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'SIGNER_PAYLOAD_INVALID'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, v_request_test_mode, null::timestamptz;
    return;
  end if;
  select btrim(signer.value ->> 'emailAddress')
  into v_submitted_seller_email
  from jsonb_array_elements(p_signer_snapshot) signer(value)
  where signer.value ->> 'role' = v_template.seller_role;
  if v_submitted_seller_email is null
     or v_submitted_seller_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'SIGNER_PAYLOAD_INVALID'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, v_request_test_mode, null::timestamptz;
    return;
  end if;
  if v_homeowner_contact.phone_1 is null
     and exists (
       select 1
       from public.contacts contact
       where contact.org_id = p_org_id
         and contact.id <> v_homeowner_contact_id
         and contact.phone_1 is null
         and lower(contact.email) = lower(v_submitted_seller_email)
     ) then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'SELLER_EMAIL_CONFLICT'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, v_request_test_mode, null::timestamptz;
    return;
  end if;
  if p_retry_of_request_id is not null then
    select * into v_previous from public.esign_requests
    where id = p_retry_of_request_id and org_id = p_org_id
    for update;
    if not found
       or v_previous.property_id <> p_property_id
       or v_previous.template_id <> p_template_id
       or v_previous.test_mode is distinct from v_request_test_mode
       or v_previous.delivery_state <> 'failed' then
      return query select
        'blocked'::public.esign_request_claim_outcome,
        'RETRY_NOT_ELIGIBLE'::text,
        null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
        p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
        p_merge_value_snapshot, null::public.esign_request_status,
        null::public.esign_delivery_state, v_request_test_mode, null::timestamptz;
      return;
    end if;
    v_created_at := greatest(
      v_created_at, v_previous.created_at + interval '1 microsecond'
    );
  end if;
  insert into public.esign_requests (
    id, org_id, property_id, template_id, signer_snapshot,
    merge_value_snapshot, status, delivery_state, test_mode,
    send_intent_id, payload_hash, retry_of_request_id,
    claimed_homeowner_contact_id, created_by, created_at
  ) values (
    v_id, p_org_id, p_property_id, p_template_id, p_signer_snapshot,
    p_merge_value_snapshot, 'awaiting', 'sending', v_request_test_mode,
    p_send_intent_id, p_payload_hash, p_retry_of_request_id,
    v_homeowner_contact_id,
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
    jsonb_build_object('template_title', v_template.name, 'test_mode', v_request_test_mode),
    'esign_request', v_id
  ) on conflict (source_type, source_id) where source_id is not null do nothing;
  return query select
    'created'::public.esign_request_claim_outcome, null::text,
    v_id, p_org_id, p_property_id, p_template_id, p_send_intent_id,
    p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
    p_merge_value_snapshot, 'awaiting'::public.esign_request_status,
    'sending'::public.esign_delivery_state, v_request_test_mode, v_created_at;
end;
$$;

revoke all on function public.create_esign_request(
  uuid, uuid, uuid, jsonb, jsonb, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.create_esign_request(
  uuid, uuid, uuid, jsonb, jsonb, uuid, text, uuid, uuid
) to service_role;

comment on function public.create_esign_request(
  uuid, uuid, uuid, jsonb, jsonb, uuid, text, uuid, uuid
) is 'Atomically claims an eSign request from the validated dialog signer snapshot and snapshots the current Dropbox Sign request mode without mutating lead canonical email before confirmed provider delivery.';

create or replace function public.reserve_esign_live_send(
  p_org_id uuid,
  p_request_id uuid,
  p_provider_remaining integer
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_integration public.org_esign_integrations%rowtype;
  v_current_period_key text := to_char(now() at time zone 'America/Chicago', 'YYYY-MM');
  v_current_period_started_at timestamptz :=
    (
      date_trunc('month', now() at time zone 'America/Chicago')
        at time zone 'America/Chicago'
    );
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v_request
  from public.esign_requests request
  where request.id = p_request_id
    and request.org_id = p_org_id
  for update;
  if not found then
    raise exception 'eSign request not found' using errcode = 'P0002';
  end if;
  if v_request.test_mode then
    return 'not_live';
  end if;
  if v_request.live_send_reserved_at is not null then
    return 'reserved';
  end if;
  if v_request.delivery_state <> 'sending' or v_request.sign_request_id is not null then
    return 'blocked';
  end if;
  if p_provider_remaining is null or p_provider_remaining <= 10 then
    return 'blocked';
  end if;
  select * into v_integration
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for update;
  if found and v_integration.live_send_monthly_period_key <> v_current_period_key then
    update public.org_esign_integrations
    set live_send_monthly_used = 0,
        live_send_monthly_period_key = v_current_period_key,
        live_send_monthly_period_started_at = v_current_period_started_at,
        updated_at = now()
    where org_id = p_org_id
      and provider = 'dropbox_sign';
    v_integration.live_send_monthly_used := 0;
    v_integration.live_send_monthly_period_key := v_current_period_key;
    v_integration.live_send_monthly_period_started_at := v_current_period_started_at;
  end if;
  if not found
     or v_integration.test_mode
     or not v_integration.sending_enabled
     or v_integration.live_send_monthly_used >= v_integration.live_send_monthly_limit then
    return 'blocked';
  end if;
  update public.esign_requests
  set live_send_reserved_at = now(),
      provider_remaining_at_claim = p_provider_remaining,
      updated_at = now()
  where id = p_request_id
    and org_id = p_org_id
    and live_send_reserved_at is null;
  if not found then
    return 'reserved';
  end if;
  update public.org_esign_integrations
  set live_send_monthly_used = live_send_monthly_used + 1,
      updated_at = now()
  where org_id = p_org_id
    and provider = 'dropbox_sign';
  return 'reserved';
end;
$$;

revoke all on function public.reserve_esign_live_send(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_esign_live_send(uuid, uuid, integer)
  to service_role;

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
declare
  v_request public.esign_requests%rowtype;
  v_release_local_live_reservation boolean := false;
  v_reservation_period_key text;
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

  select * into v_request
  from public.esign_requests request
  where request.id = p_request_id
    and request.org_id = p_org_id
  for update;

  if not found then
    raise exception 'eSign request is not sending' using errcode = '55000';
  end if;
  if v_request.delivery_state = p_delivery_state
     and p_delivery_state = 'failed'
     and v_request.status = 'error'
     and v_request.sign_request_id is null
     and v_request.live_send_reserved_at is null
     and v_request.provider_remaining_at_claim is null
     and v_request.error_message is not distinct from p_error_message then
    return;
  end if;
  if v_request.delivery_state <> 'sending' then
    raise exception 'eSign request is not sending' using errcode = '55000';
  end if;

  v_release_local_live_reservation :=
    p_delivery_state = 'failed'
    and v_request.test_mode = false
    and v_request.live_send_reserved_at is not null
    and v_request.sign_request_id is null
    and p_error_message in ('PROVIDER_REJECTED', 'PROVIDER_PLAN_REQUIRED');

  if v_release_local_live_reservation then
    v_reservation_period_key :=
      to_char(v_request.live_send_reserved_at at time zone 'America/Chicago', 'YYYY-MM');
    update public.org_esign_integrations integration
    set live_send_monthly_used = greatest(0, integration.live_send_monthly_used - 1),
        updated_at = now()
    where integration.org_id = p_org_id
      and integration.provider = 'dropbox_sign'
      and integration.live_send_monthly_period_key = v_reservation_period_key
      and integration.live_send_monthly_used > 0;
  end if;

  update public.esign_requests
  set delivery_state = p_delivery_state,
      status = case when p_delivery_state = 'failed' then 'error' else status end,
      completed_at = case
        when p_delivery_state = 'failed' then now() else completed_at end,
      error_message = case when p_delivery_state = 'failed'
        then p_error_message else null end,
      live_send_reserved_at = case
        when v_release_local_live_reservation then null else live_send_reserved_at end,
      provider_remaining_at_claim = case
        when v_release_local_live_reservation then null else provider_remaining_at_claim end,
      updated_by = null,
      updated_at = now()
  where id = p_request_id
    and org_id = p_org_id
    and delivery_state = 'sending';
end;
$$;

revoke all on function public.mark_esign_request_send_outcome(
  uuid, uuid, public.esign_delivery_state, text
) from public, anon, authenticated, service_role;
grant execute on function public.mark_esign_request_send_outcome(
  uuid, uuid, public.esign_delivery_state, text
) to service_role;

create or replace function public.repair_esign_provider_plan_required_send(
  p_org_id uuid,
  p_request_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_reservation_period_key text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select * into v_request
  from public.esign_requests request
  where request.id = p_request_id
    and request.org_id = p_org_id
  for update;

  if not found then
    raise exception 'eSign request not found' using errcode = 'P0002';
  end if;
  if v_request.delivery_state = 'failed'
     and v_request.status = 'error'
     and v_request.sign_request_id is null
     and v_request.live_send_reserved_at is null
     and v_request.provider_remaining_at_claim is null
     and v_request.error_message = 'PROVIDER_PLAN_REQUIRED' then
    return 'already_repaired';
  end if;
  if v_request.delivery_state <> 'sending'
     or v_request.test_mode
     or v_request.sign_request_id is not null
     or v_request.live_send_reserved_at is null then
    raise exception 'eSign request is not a provider-plan-required live reservation'
      using errcode = '55000';
  end if;

  v_reservation_period_key :=
    to_char(v_request.live_send_reserved_at at time zone 'America/Chicago', 'YYYY-MM');

  update public.org_esign_integrations integration
  set live_send_monthly_used = greatest(0, integration.live_send_monthly_used - 1),
      updated_at = now()
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
    and integration.live_send_monthly_period_key = v_reservation_period_key
    and integration.live_send_monthly_used > 0;

  update public.esign_requests
  set delivery_state = 'failed',
      status = 'error',
      completed_at = now(),
      error_message = 'PROVIDER_PLAN_REQUIRED',
      live_send_reserved_at = null,
      provider_remaining_at_claim = null,
      updated_by = null,
      updated_at = now()
  where id = p_request_id
    and org_id = p_org_id
    and delivery_state = 'sending'
    and test_mode = false
    and sign_request_id is null
    and live_send_reserved_at is not null;
  if not found then
    raise exception 'eSign request is not a provider-plan-required live reservation'
      using errcode = '55000';
  end if;

  return 'repaired';
end;
$$;

revoke all on function public.repair_esign_provider_plan_required_send(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.repair_esign_provider_plan_required_send(uuid, uuid)
  to service_role;

comment on function public.repair_esign_provider_plan_required_send(uuid, uuid) is
  'Service-role repair for a known Dropbox Sign PROVIDER_PLAN_REQUIRED live-send reservation with no provider request id. Releases only Sandra-owned local fuse state and never retries or resends.';

create or replace function public.resolve_esign_send_unknown_not_sent(
  p_org_id uuid,
  p_request_id uuid,
  p_actor_id uuid,
  p_resolution_source text,
  p_error_message text,
  p_evidence jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_event_type text;
  v_release_local_live_reservation boolean := false;
  v_reservation_period_key text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_resolution_source not in ('automatic', 'operator')
     or (p_resolution_source = 'operator' and p_actor_id is null)
     or (p_resolution_source = 'automatic' and p_actor_id is not null)
     or coalesce(p_error_message, '') !~ '^[A-Z][A-Z0-9_]{0,127}$'
     or jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object'
     or (
       p_resolution_source = 'automatic'
       and coalesce(p_evidence ->> 'positiveControl', '') <> 'passed'
     )
     or (
       p_resolution_source = 'operator'
       and coalesce(p_evidence ->> 'acknowledgedFailure', '') <> p_error_message
     ) then
    raise exception 'invalid eSign send-not-found resolution'
      using errcode = '23514';
  end if;
  if p_resolution_source = 'operator' then
    perform public.esign_require_active_owner(p_org_id, p_actor_id);
  end if;
  v_event_type := case p_resolution_source
    when 'operator' then 'esign_send_not_found_operator'
    else 'esign_send_not_found_automatic'
  end;

  select request.* into v_request
  from public.esign_requests request
  where request.id = p_request_id
    and request.org_id = p_org_id
  for update;
  if not found then
    raise exception 'eSign request not found' using errcode = 'P0002';
  end if;
  if p_resolution_source = 'automatic'
     and (v_request.delivery_state <> 'send_unknown'
       or v_request.sign_request_id is not null) then
    raise exception 'eSign request is not an unresolved unknown send'
      using errcode = '55000';
  end if;
  if p_resolution_source = 'operator'
     and (v_request.delivery_state <> 'failed'
       or v_request.sign_request_id is not null
       or v_request.error_message is distinct from p_error_message) then
    raise exception 'eSign request is not an evidenced failed send'
      using errcode = '55000';
  end if;
  if p_resolution_source = 'operator'
     and exists (
       select 1
       from public.lead_events event
       where event.source_type = v_event_type
         and event.source_id = p_request_id
         and event.org_id = p_org_id
         and event.property_id = v_request.property_id
         and event.actor_type = 'user'
         and event.event_type = v_event_type
     ) then
    return;
  end if;

  v_release_local_live_reservation :=
    p_resolution_source = 'automatic'
    and v_request.test_mode = false
    and v_request.live_send_reserved_at is not null
    and v_request.sign_request_id is null
    and p_error_message = 'PROVIDER_SEND_NOT_FOUND';

  if v_release_local_live_reservation then
    v_reservation_period_key :=
      to_char(v_request.live_send_reserved_at at time zone 'America/Chicago', 'YYYY-MM');
    update public.org_esign_integrations integration
    set live_send_monthly_used = greatest(0, integration.live_send_monthly_used - 1),
        updated_at = now()
    where integration.org_id = p_org_id
      and integration.provider = 'dropbox_sign'
      and integration.live_send_monthly_period_key = v_reservation_period_key
      and integration.live_send_monthly_used > 0;
  end if;

  if p_resolution_source = 'automatic' then
    update public.esign_requests
    set delivery_state = 'failed',
        status = 'error',
        completed_at = now(),
        error_message = p_error_message,
        live_send_reserved_at = case
          when v_release_local_live_reservation then null else live_send_reserved_at end,
        provider_remaining_at_claim = case
          when v_release_local_live_reservation then null else provider_remaining_at_claim end,
        updated_by = null,
        updated_at = now()
    where id = p_request_id
      and org_id = p_org_id
      and delivery_state = 'send_unknown'
      and sign_request_id is null;
    if not found then
      raise exception 'eSign request is not an unresolved unknown send'
        using errcode = '55000';
    end if;
  else
    update public.esign_requests
    set updated_by = p_actor_id,
        updated_at = now()
    where id = p_request_id
      and org_id = p_org_id
      and delivery_state = 'failed'
      and sign_request_id is null
      and error_message = p_error_message;
    if not found then
      raise exception 'eSign request is not an evidenced failed send'
        using errcode = '55000';
    end if;
  end if;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    p_org_id,
    v_request.property_id,
    case when p_resolution_source = 'operator' then 'user' else 'system' end,
    p_actor_id,
    v_event_type,
    jsonb_build_object(
      'request_id', p_request_id,
      'error_message', p_error_message,
      'evidence', coalesce(p_evidence, '{}'::jsonb)
    ),
    v_event_type,
    p_request_id
  ) on conflict (source_type, source_id) where source_id is not null do nothing;
end;
$$;

revoke all on function public.resolve_esign_send_unknown_not_sent(
  uuid, uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.resolve_esign_send_unknown_not_sent(
  uuid, uuid, uuid, text, text, jsonb
) to service_role;

drop function if exists public.find_esign_webhook_request(uuid, text);

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
  template_title text,
  test_mode boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select request.id, request.org_id, request.property_id, request.status,
    request.signed_pdf_path, template.name, request.test_mode
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

commit;
