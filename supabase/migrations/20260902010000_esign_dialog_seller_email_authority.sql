-- The validated Seller signer submitted from the send dialog is authoritative
-- for this request. Persist it to the lead only after provider delivery has been
-- confirmed by reconcile_esign_request_delivery. Both RPC signatures remain
-- unchanged so either application version can run before or after this migration.

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
  -- Discover the relationship without a row lock, then follow Sandra's canonical
  -- contact -> property lock order. Re-check the relationship after both locks so
  -- a concurrent reassignment cannot make us claim against the wrong contact.
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
      null::public.esign_delivery_state, true, null::timestamptz;
    return;
  end if;
  if v_homeowner_contact_id is null then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'MISSING_HOMEOWNER_EMAIL'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, true, null::timestamptz;
    return;
  end if;
  select * into v_homeowner_contact from public.contacts contact
  where contact.id = v_homeowner_contact_id and contact.org_id = p_org_id
  for update;
  if not found then
    return query select
      'blocked'::public.esign_request_claim_outcome,
      'MISSING_HOMEOWNER_EMAIL'::text,
      null::uuid, p_org_id, p_property_id, p_template_id, p_send_intent_id,
      p_payload_hash, p_retry_of_request_id, p_signer_snapshot,
      p_merge_value_snapshot, null::public.esign_request_status,
      null::public.esign_delivery_state, true, null::timestamptz;
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
      null::public.esign_delivery_state, true, null::timestamptz;
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
      null::public.esign_delivery_state, true, null::timestamptz;
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

revoke all on function public.create_esign_request(
  uuid, uuid, uuid, jsonb, jsonb, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.create_esign_request(
  uuid, uuid, uuid, jsonb, jsonb, uuid, text, uuid, uuid
) to service_role;

comment on function public.create_esign_request(
  uuid, uuid, uuid, jsonb, jsonb, uuid, text, uuid, uuid
) is 'Atomically claims an eSign request from the validated dialog signer snapshot without changing the lead canonical email before confirmed provider delivery.';

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
  v_property_id uuid;
  v_homeowner_contact_id uuid;
  v_locked_homeowner_contact_id uuid;
  v_submitted_seller_email text;
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

  select request.property_id, property.homeowner_contact_id,
         btrim(seller.value ->> 'emailAddress')
  into v_property_id, v_homeowner_contact_id, v_submitted_seller_email
  from public.esign_requests request
  join public.properties property
    on property.id = request.property_id and property.org_id = request.org_id
  join public.esign_templates template
    on template.id = request.template_id and template.org_id = request.org_id
  cross join lateral jsonb_array_elements(request.signer_snapshot) seller(value)
  where request.id = p_request_id
    and request.org_id = p_org_id
    and seller.value ->> 'role' = template.seller_role;
  if not found or v_homeowner_contact_id is null then
    raise exception 'eSign request homeowner contact is unavailable'
      using errcode = '55000';
  end if;

  -- Match Sandra's contact -> property order before touching the request rows.
  perform 1 from public.contacts contact
  where contact.id = v_homeowner_contact_id and contact.org_id = p_org_id
  for update;
  if not found then
    raise exception 'eSign request homeowner contact is unavailable'
      using errcode = '55000';
  end if;
  select property.homeowner_contact_id into v_locked_homeowner_contact_id
  from public.properties property
  where property.id = v_property_id and property.org_id = p_org_id
  for update;
  if not found or v_locked_homeowner_contact_id is distinct from v_homeowner_contact_id then
    raise exception 'eSign request homeowner contact changed before delivery confirmation'
      using errcode = '40001';
  end if;
  perform 1 from public.esign_requests request
  where request.id = p_request_id and request.org_id = p_org_id
    and request.property_id = v_property_id
    and request.delivery_state in ('sending', 'send_unknown')
  for update;
  if not found then
    raise exception 'eSign request is not awaiting provider reconciliation'
      using errcode = '55000';
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

  update public.contacts
  set email = v_submitted_seller_email
  where id = v_homeowner_contact_id and org_id = p_org_id;
  if not found then
    raise exception 'eSign request homeowner contact changed during reconciliation'
      using errcode = '40001';
  end if;
end;
$$;

revoke all on function public.reconcile_esign_request_delivery(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_esign_request_delivery(
  uuid, uuid, text, text, jsonb
) to service_role;

comment on function public.reconcile_esign_request_delivery(
  uuid, uuid, text, text, jsonb
) is 'Confirms provider delivery, then atomically persists the request Seller email using Sandra contact-first lock order.';
