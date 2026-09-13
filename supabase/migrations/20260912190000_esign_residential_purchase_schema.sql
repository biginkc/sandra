-- Support the saved residential purchase contract while retaining legacy snapshots.
begin;

create or replace function public.esign_merge_fields_are_valid(p_fields text[])
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select coalesce((select array_agg(field order by field) from unnest(p_fields) field)
    in (array['closing_date', 'earnest_money', 'offer_price', 'property_address', 'seller_name']::text[], array['additional_terms', 'buyer_name', 'cash_balance', 'closing_date', 'earnest_money', 'earnest_money_holder', 'legal_description', 'offer_price', 'property_address', 'property_city', 'property_state', 'property_zip', 'seller_name']::text[]), false);
$$;

-- Metadata extraction is shared by validation, availability and registration.
create or replace function public.esign_website_sender_field_names(p_metadata jsonb)
returns text[] language sql immutable set search_path = public, pg_temp as $$
  select array_agg(field ->> 'name' order by field ->> 'name')
  from jsonb_array_elements(case when jsonb_typeof(p_metadata -> 'documents') = 'array'
    then p_metadata -> 'documents' else '[]'::jsonb end) document
  cross join lateral jsonb_array_elements(case when jsonb_typeof(document -> 'customFields') = 'array'
    then document -> 'customFields' else '[]'::jsonb end) field
  where field ->> 'assignedTo' = 'sender';
$$;
revoke all on function public.esign_website_sender_field_names(jsonb) from public, anon, authenticated;
grant execute on function public.esign_website_sender_field_names(jsonb) to service_role;

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
    where field.value ->> 'name' = any(public.esign_website_sender_field_names(p_metadata))
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
  select coalesce(btrim(coalesce(p_provider_template_id, '')) <> ''
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
    and public.esign_merge_fields_are_valid(public.esign_website_sender_field_names(p_metadata))
    and (select count(*) from custom_fields) = cardinality(public.esign_website_sender_field_names(p_metadata))
    and (select count(*) from sender_merge_fields) = cardinality(public.esign_website_sender_field_names(p_metadata))
    and (cardinality(public.esign_website_sender_field_names(p_metadata)) <> 13 or not exists (
      select 1 from sender_custom_fields
      where field -> 'required' is distinct from to_jsonb(field ->> 'name' <> 'additional_terms')
    ))
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
    ), false);
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
      and template.provider_metadata_unavailable_at is null
      and (
        template.template_origin = 'sandra_embedded'
        or (
          template.provider_metadata_attested_at >= now() - interval '30 days'
          and (select array_agg(name order by name) from unnest(template.merge_field_names) name)
            = public.esign_website_sender_field_names(template.provider_metadata)
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

create or replace function public.esign_request_payload_is_valid(
  p_signers jsonb, p_merge_values jsonb, p_template_roles jsonb, p_template_merge_fields text[]
)
returns boolean language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if jsonb_typeof(p_signers) is distinct from 'array'
    or jsonb_typeof(p_merge_values) is distinct from 'object'
    or jsonb_typeof(p_template_roles) is distinct from 'array'
    or not public.esign_merge_fields_are_valid(p_template_merge_fields) then
    return false;
  end if;
  return jsonb_array_length(p_signers) = jsonb_array_length(p_template_roles)
    and not exists (
      select 1 from jsonb_array_elements(p_signers) with ordinality signer(value, position)
      join jsonb_array_elements(p_template_roles) with ordinality role(value, position) using (position)
      where jsonb_typeof(signer.value) is distinct from 'object'
        or signer.value ->> 'role' is distinct from role.value ->> 'name'
        or jsonb_typeof(signer.value -> 'name') is distinct from 'string'
        or jsonb_typeof(signer.value -> 'emailAddress') is distinct from 'string'
        or btrim(coalesce(signer.value ->> 'name', '')) = ''
        or btrim(coalesce(signer.value ->> 'emailAddress', '')) = ''
    )
    and (select array_agg(key order by key) from jsonb_object_keys(p_merge_values) key)
      = (select array_agg(name order by name) from unnest(p_template_merge_fields) name)
    and not exists (
      select 1 from jsonb_each(p_merge_values) item
      where jsonb_typeof(item.value) is distinct from 'string'
        or (item.key <> 'additional_terms' and btrim(item.value #>> '{}') = '')
    );
end;
$$;
revoke all on function public.esign_request_payload_is_valid(jsonb,jsonb,jsonb,text[]) from public, anon, authenticated;
grant execute on function public.esign_request_payload_is_valid(jsonb,jsonb,jsonb,text[]) to service_role;

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
    p_signer_snapshot, p_merge_value_snapshot, v_template.signer_roles, v_template.merge_field_names
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

commit;
