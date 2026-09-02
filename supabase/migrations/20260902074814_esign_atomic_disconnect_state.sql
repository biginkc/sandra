-- Atomic disconnect state for Dropbox Sign.
-- A disconnect that is blocked by active eSign lifecycle work disables new
-- provider mutations while preserving callback ingestion until work is terminal.

alter table public.org_esign_integrations
  alter column api_key_encrypted drop not null,
  alter column api_key_last_four drop not null,
  alter column client_id drop not null,
  alter column provider_account_id drop not null;

alter table public.org_esign_integrations
  add column if not exists disconnect_pending_at timestamptz,
  add column if not exists disconnect_requested_by uuid references auth.users(id);

alter table public.org_esign_integrations
  drop constraint if exists org_esign_integrations_credentials_all_or_none;

alter table public.org_esign_integrations
  add constraint org_esign_integrations_credentials_all_or_none check (
    (
      api_key_encrypted is not null
      and api_key_last_four is not null
      and client_id is not null
      and provider_account_id is not null
      and callback_consumer_id is not null
    )
    or (
      api_key_encrypted is null
      and api_key_last_four is null
      and client_id is null
      and provider_account_id is null
      and not sending_enabled
    )
  );

alter table public.org_esign_integrations
  drop constraint if exists org_esign_integrations_pending_disconnect_check;
alter table public.org_esign_integrations
  add constraint org_esign_integrations_pending_disconnect_check check (
    disconnect_pending_at is null
    or (
      not sending_enabled
      and disconnect_requested_by is not null
      and api_key_encrypted is not null
      and api_key_last_four is not null
      and client_id is not null
      and provider_account_id is not null
      and callback_consumer_id is not null
    )
  );

create or replace function public.esign_require_template_management_capability(
  p_org_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_provider_account_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  join public.webhook_consumers consumer
    on consumer.id = integration.callback_consumer_id
   and consumer.org_id = integration.org_id
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
    and integration.api_key_encrypted is not null
    and integration.api_key_last_four is not null
    and integration.client_id is not null
    and integration.provider_account_id is not null
    and integration.disconnect_pending_at is null
    and integration.disconnect_requested_by is null
    and consumer.consumer_type = 'esign_provider'
    and consumer.enabled
    and consumer.revoked_at is null
  for share;
  if not found then
    raise exception 'active Dropbox Sign template management capability not found'
      using errcode = 'P0002';
  end if;
  return v_provider_account_id;
end;
$$;

create or replace function public.upsert_org_esign_integration(
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
declare
  v_callback_consumer_id uuid := gen_random_uuid();
  v_existing public.org_esign_integrations%rowtype;
  v_has_existing boolean := false;
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

  select * into v_existing
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for update;
  v_has_existing := found;

  if v_has_existing and v_existing.api_key_encrypted is not null then
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

  if v_has_existing then
    update public.webhook_consumers
    set enabled = false,
        revoked_at = coalesce(revoked_at, now()),
        secret_hash = encode(
          extensions.digest(
            convert_to(secret_hash || ':' || id::text, 'utf8'),
            'sha256'
          ),
          'hex'
        )
    where id = v_existing.callback_consumer_id
      and consumer_type = 'esign_provider'
      and (enabled or revoked_at is null);

    update public.org_esign_integrations
    set api_key_encrypted = extensions.pgp_sym_encrypt(
          p_api_key,
          p_key,
          'cipher-algo=aes256'
        ),
        api_key_last_four = p_api_key_last_four,
        client_id = p_client_id,
        provider_account_id = p_provider_account_id,
        callback_consumer_id = v_callback_consumer_id,
        callback_verified_at = null,
        sending_enabled = false,
        test_mode = true,
        disconnect_pending_at = null,
        disconnect_requested_by = null,
        connected_by = p_actor_id,
        updated_by = p_actor_id,
        updated_at = now()
    where org_id = p_org_id
      and provider = 'dropbox_sign';
    return;
  end if;

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

create or replace function public.get_org_esign_credentials(
  p_org_id uuid,
  p_key text
)
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
  select
    extensions.pgp_sym_decrypt(integration.api_key_encrypted, p_key),
    integration.client_id,
    integration.provider_account_id,
    integration.sending_enabled,
    integration.test_mode,
    consumer.secret_hash
  from public.org_esign_integrations integration
  join public.webhook_consumers consumer
    on consumer.id = integration.callback_consumer_id
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
    and integration.api_key_encrypted is not null
    and integration.api_key_last_four is not null
    and integration.client_id is not null
    and integration.provider_account_id is not null
    and consumer.enabled
    and consumer.revoked_at is null
    and coalesce(auth.role(), '') = 'service_role';
$$;

create or replace function public.disconnect_org_esign_integration(
  p_org_id uuid,
  p_actor_id uuid
)
returns table (
  disconnected boolean,
  sending_enabled boolean,
  credentials_present boolean,
  disconnect_pending boolean,
  message text
)
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_integration public.org_esign_integrations%rowtype;
  v_active_request_count integer := 0;
  v_provider_template_count integer := 0;
  v_unfinished_template_count integer := 0;
  v_cleanup_template_count integer := 0;
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
    return query select
      true, false, false, false, 'Dropbox Sign disconnected.'::text;
    return;
  end if;

  update public.org_esign_integrations
  set sending_enabled = false,
      updated_by = p_actor_id,
      updated_at = now()
  where org_id = p_org_id
    and provider = 'dropbox_sign';

  select count(*) into v_active_request_count
  from public.esign_requests request
  where request.org_id = p_org_id
    and (
      request.status in ('awaiting', 'viewed')
      or request.delivery_state::text in ('sending', 'send_unknown', 'email_bounced')
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

  select count(*) into v_provider_template_count
  from public.esign_templates template
  where template.org_id = p_org_id
    and template.provider_create_state in ('claimed', 'invoking', 'unknown');

  if v_provider_template_count > 0 then
    return query select
      false,
      false,
      true,
      false,
      format(
        'Dropbox Sign sending is off. Active eSign work remains: %s provider template operation%s. Finish or abandon template setup before disconnecting.',
        v_provider_template_count,
        case when v_provider_template_count = 1 then '' else 's' end
      )::text;
    return;
  end if;

  select count(*) into v_unfinished_template_count
  from public.esign_templates template
  where template.org_id = p_org_id
    and template.finalized_at is null
    and template.deleted_at is null
    and template.abandoned_at is null;

  if v_unfinished_template_count > 0 then
    return query select
      false,
      false,
      true,
      false,
      format(
        'Dropbox Sign sending is off. Active eSign work remains: %s unfinished template setup%s. Finish or abandon template setup before disconnecting.',
        v_unfinished_template_count,
        case when v_unfinished_template_count = 1 then '' else 's' end
      )::text;
    return;
  end if;

  select count(*) into v_cleanup_template_count
  from public.esign_templates template
  join public.esign_template_staging_sources source
    on source.id = template.staging_source_id
   and source.org_id = template.org_id
  where template.org_id = p_org_id
    and source.cleanup_outcome in ('pending', 'in_progress', 'failed');

  if v_cleanup_template_count > 0 then
    return query select
      false,
      false,
      true,
      false,
      format(
        'Dropbox Sign sending is off. Active eSign work remains: %s attached template source cleanup task%s. Finish attached template source cleanup before disconnecting.',
        v_cleanup_template_count,
        case when v_cleanup_template_count = 1 then '' else 's' end
      )::text;
    return;
  end if;

  if v_active_request_count > 0 then
    update public.org_esign_integrations
    set sending_enabled = false,
        disconnect_pending_at = coalesce(disconnect_pending_at, now()),
        disconnect_requested_by = p_actor_id,
        updated_by = p_actor_id,
        updated_at = now()
    where org_id = p_org_id
      and provider = 'dropbox_sign';
    return query select
      false,
      false,
      true,
      true,
      format(
        'Dropbox Sign sending is off. Active eSign work remains: %s signature request%s. Callback ingestion and read credentials are preserved until the active work reaches a terminal state. Manage templates and new sends stay blocked.',
        v_active_request_count,
        case when v_active_request_count = 1 then '' else 's' end
      )::text;
    return;
  end if;

  delete from public.org_esign_integrations
  where org_id = p_org_id
    and provider = 'dropbox_sign';
  update public.webhook_consumers
  set enabled = false,
      revoked_at = coalesce(revoked_at, now()),
      secret_hash = encode(
        extensions.digest(
          convert_to(secret_hash || ':' || id::text, 'utf8'),
          'sha256'
        ),
        'hex'
      )
  where id = v_integration.callback_consumer_id
    and consumer_type = 'esign_provider'
    and (enabled or revoked_at is null);

  return query select
    true, false, false, false, 'Dropbox Sign disconnected.'::text;
end;
$$;

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
    and integration.provider = 'dropbox_sign'
  for update;
  if not found then
    raise exception 'Dropbox Sign is not connected' using errcode = 'P0002';
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
  update public.org_esign_integrations
  set sending_enabled = p_enabled,
      updated_by = p_actor_id,
      updated_at = now()
  where org_id = p_org_id
    and provider = 'dropbox_sign';
end;
$$;

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
      and integration.api_key_encrypted is not null
      and integration.api_key_last_four is not null
      and integration.client_id is not null
      and integration.provider_account_id is not null
      and integration.disconnect_pending_at is null
      and integration.disconnect_requested_by is null
      and consumer.consumer_type = 'esign_provider'
      and consumer.enabled
      and consumer.revoked_at is null
  );
$$;

create or replace function public.delete_org_esign_integration(
  p_org_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_result record;
begin
  select * into v_result
  from public.disconnect_org_esign_integration(p_org_id, p_actor_id);
  if not coalesce(v_result.disconnected, false) then
    raise exception '%', v_result.message using errcode = '23514';
  end if;
end;
$$;

revoke all on function public.disconnect_org_esign_integration(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.disconnect_org_esign_integration(uuid, uuid)
  to service_role;

revoke all on function public.upsert_org_esign_integration(
  uuid, text, text, text, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.upsert_org_esign_integration(
  uuid, text, text, text, text, text, uuid, text
) to service_role;

revoke all on function public.get_org_esign_credentials(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_org_esign_credentials(uuid, text)
  to service_role;

revoke all on function public.set_org_esign_sending_enabled(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_org_esign_sending_enabled(uuid, uuid, boolean)
  to service_role;

revoke all on function public.delete_org_esign_integration(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_org_esign_integration(uuid, uuid)
  to service_role;

revoke all on function public.esign_require_template_management_capability(uuid)
  from public, anon, authenticated;
grant execute on function public.esign_require_template_management_capability(uuid)
  to service_role;

revoke all on function public.esign_template_is_available(uuid, uuid)
  from public, anon;
grant execute on function public.esign_template_is_available(uuid, uuid)
  to authenticated, service_role;
