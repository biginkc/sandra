-- Website templates retain their provider document and request history when removed locally.
begin;

alter table public.esign_templates
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
      and (
        lifecycle_state = 'finalized'
        or (lifecycle_state = 'deleted' and deleted_at is not null and deleted_by is not null)
      )
      and jsonb_typeof(provider_metadata) = 'object'
      and provider_metadata_attested_at is not null
      and (
        provider_metadata_unavailable_at is null
        or provider_metadata_unavailable_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'
      )
    )
  );

-- Restoration must undo both local deletion markers and lifecycle state.
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
    public.esign_website_sender_field_names(p_provider_metadata),
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
  if (select array_agg(name order by name) from unnest(v_existing.merge_field_names) name)
     is distinct from public.esign_website_sender_field_names(p_provider_metadata) then
    raise exception 'Dropbox Sign template field schema changed; register a new template'
      using errcode = '23514';
  end if;
  update public.esign_templates
  set name = btrim(p_name),
      document_type = btrim(p_document_type),
      lifecycle_state = 'finalized',
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

commit;
