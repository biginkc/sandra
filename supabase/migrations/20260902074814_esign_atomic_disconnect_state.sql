-- Atomic disconnect state for Dropbox Sign.
-- A disconnect that is blocked by active eSign lifecycle work must still remove
-- provider credentials and disable new provider capability in one transaction.

alter table public.org_esign_integrations
  alter column api_key_encrypted drop not null,
  alter column api_key_last_four drop not null,
  alter column client_id drop not null,
  alter column provider_account_id drop not null;

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

  if found and v_existing.api_key_encrypted is not null then
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

  if found then
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
  message text
)
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_integration public.org_esign_integrations%rowtype;
  v_blocked boolean := false;
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
      true, false, false, 'Dropbox Sign disconnected.'::text;
    return;
  end if;

  update public.org_esign_integrations
  set sending_enabled = false,
      updated_by = p_actor_id,
      updated_at = now()
  where org_id = p_org_id
    and provider = 'dropbox_sign';

  select exists (
    select 1
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
      )
  )
  or exists (
    select 1
    from public.esign_templates template
    where template.org_id = p_org_id
      and template.provider_create_state in ('claimed', 'invoking', 'unknown')
  )
  or exists (
    select 1
    from public.esign_templates template
    where template.org_id = p_org_id
      and template.finalized_at is null
      and template.deleted_at is null
      and template.abandoned_at is null
  )
  or exists (
    select 1
    from public.esign_templates template
    join public.esign_template_staging_sources source
      on source.id = template.staging_source_id
     and source.org_id = template.org_id
    where template.org_id = p_org_id
      and source.cleanup_outcome in ('pending', 'in_progress', 'failed')
  )
  into v_blocked;

  if v_blocked then
    update public.org_esign_integrations
    set api_key_encrypted = null,
        api_key_last_four = null,
        client_id = null,
        provider_account_id = null,
        callback_verified_at = null,
        sending_enabled = false,
        updated_by = p_actor_id,
        updated_at = now()
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
      false,
      false,
      false,
      'Dropbox Sign sending is off and credentials were removed. Reconnect Dropbox Sign before managing templates or sending new contracts.'::text;
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
    true, false, false, 'Dropbox Sign disconnected.'::text;
end;
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
begin
  perform 1
  from public.disconnect_org_esign_integration(p_org_id, p_actor_id);
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

revoke all on function public.delete_org_esign_integration(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_org_esign_integration(uuid, uuid)
  to service_role;
