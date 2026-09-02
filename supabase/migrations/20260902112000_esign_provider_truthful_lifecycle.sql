begin;

create or replace function public.reconcile_esign_webhook_provider_signers(
  p_org_id uuid,
  p_request_id uuid,
  p_receipt_id uuid,
  p_lease_id uuid,
  p_provider_event_at timestamptz,
  p_provider_signatures jsonb default '[]'::jsonb,
  p_signed_provider_signature_id text default null
)
returns table (outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_receipt public.esign_webhook_receipts%rowtype;
  v_signatures jsonb := coalesce(p_provider_signatures, '[]'::jsonb);
  v_signature record;
  v_changed boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider_event_at is null
     or jsonb_typeof(v_signatures) <> 'array'
     or jsonb_array_length(v_signatures) > 25 then
    raise exception 'invalid provider signer reconciliation'
      using errcode = '22023';
  end if;

  select request.* into v_request
  from public.esign_requests request
  where request.id = p_request_id and request.org_id = p_org_id
  for update;
  if not found then
    raise exception 'eSign request not found' using errcode = 'P0002';
  end if;

  select receipt.* into v_receipt
  from public.esign_webhook_receipts receipt
  where receipt.id = p_receipt_id
    and receipt.org_id = p_org_id
    and receipt.processing_status = 'processing'
    and receipt.processing_lease_id = p_lease_id
    and receipt.sign_request_id = v_request.sign_request_id
    and receipt.provider_event_at is not distinct from p_provider_event_at
    and (receipt.esign_request_id = p_request_id or receipt.esign_request_id is null)
    and receipt.event_type in (
      'signature_request_viewed',
      'signature_request_signed',
      'signature_request_all_signed',
      'signature_request_downloadable',
      'signature_request_declined',
      'signature_request_remind'
    )
  for update;
  if not found then
    raise exception 'active matching signer reconciliation receipt lease not found'
      using errcode = 'P0002';
  end if;

  if v_request.status in ('declined', 'voided') then
    return query select 'superseded'::text;
    return;
  end if;
  if v_request.provider_event_at is not null
     and p_provider_event_at < v_request.provider_event_at
     and v_receipt.event_type not in (
       'signature_request_signed',
       'signature_request_all_signed',
       'signature_request_downloadable'
     ) then
    return query select 'stale_ignored'::text;
    return;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_signatures) item(value)
    where jsonb_typeof(item.value) <> 'object'
      or btrim(coalesce(item.value ->> 'signatureId', '')) = ''
      or btrim(coalesce(item.value ->> 'role', '')) = ''
      or btrim(coalesce(item.value ->> 'name', '')) = ''
      or btrim(coalesce(item.value ->> 'emailAddress', '')) !~ '^[^[:space:]@]+@[^[:space:]@]+$'
      or not coalesce(item.value ->> 'order', '') ~ '^[0-9]+$'
  ) then
    raise exception 'invalid provider signer identity'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from (
      select item.value ->> 'role' as role_name,
        (item.value ->> 'order')::integer as signer_order,
        count(*) as count
      from jsonb_array_elements(v_signatures) item(value)
      group by item.value ->> 'role', (item.value ->> 'order')::integer
      having count(*) > 1
    ) duplicate
  ) or exists (
    select 1
    from (
      select item.value ->> 'signatureId' as signature_id, count(*) as count
      from jsonb_array_elements(v_signatures) item(value)
      group by item.value ->> 'signatureId'
      having count(*) > 1
    ) duplicate
  ) then
    raise exception 'duplicate provider signer identity'
      using errcode = '23514';
  end if;

  for v_signature in
    select
      item.value ->> 'signatureId' as signature_id,
      item.value ->> 'role' as role_name,
      item.value ->> 'name' as signer_name,
      item.value ->> 'emailAddress' as signer_email,
      (item.value ->> 'order')::integer as signer_order
    from jsonb_array_elements(v_signatures) item(value)
  loop
    update public.esign_request_signers signer
    set provider_signature_id = v_signature.signature_id,
        signer_email = v_signature.signer_email,
        signer_name = v_signature.signer_name,
        email_update_claim_token = null,
        email_update_claimed_at = null,
        email_update_claim_email = null,
        email_update_claim_actor_id = null,
        updated_at = now()
    where signer.org_id = p_org_id
      and signer.request_id = p_request_id
      and signer.role_name = v_signature.role_name
      and signer.signer_order = v_signature.signer_order
      and (
        signer.provider_signature_id is distinct from v_signature.signature_id
        or signer.signer_email is distinct from v_signature.signer_email
        or signer.signer_name is distinct from v_signature.signer_name
        or signer.email_update_claim_token is not null
      );
    if found then
      v_changed := true;
    elsif not exists (
      select 1 from public.esign_request_signers signer
      where signer.org_id = p_org_id
        and signer.request_id = p_request_id
        and signer.role_name = v_signature.role_name
        and signer.signer_order = v_signature.signer_order
        and signer.provider_signature_id = v_signature.signature_id
        and signer.signer_email = v_signature.signer_email
        and signer.signer_name = v_signature.signer_name
    ) then
      raise exception 'provider signer identity did not match local signer'
        using errcode = '23514';
    end if;
  end loop;

  if btrim(coalesce(p_signed_provider_signature_id, '')) <> '' then
    update public.esign_request_signers signer
    set status = 'signed',
        viewed_at = coalesce(signer.viewed_at, p_provider_event_at),
        signed_at = coalesce(signer.signed_at, p_provider_event_at),
        reminder_claim_token = null,
        reminder_claimed_at = null,
        updated_at = now()
    where signer.org_id = p_org_id
      and signer.request_id = p_request_id
      and signer.provider_signature_id = btrim(p_signed_provider_signature_id)
      and signer.status <> 'declined';
    if found then
      v_changed := true;
    elsif v_receipt.event_type = 'signature_request_signed' then
      raise exception 'signed provider signer did not match local signer'
        using errcode = 'P0002';
    end if;
  end if;

  update public.esign_webhook_receipts
  set esign_request_id = p_request_id
  where id = p_receipt_id and org_id = p_org_id;

  return query select case
    when v_changed then 'applied'::text
    else 'already_reconciled'::text
  end;
end;
$$;

revoke all on function public.reconcile_esign_webhook_provider_signers(
  uuid, uuid, uuid, uuid, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function public.reconcile_esign_webhook_provider_signers(
  uuid, uuid, uuid, uuid, timestamptz, jsonb, text
) to service_role;

create or replace function public.reconcile_esign_completed_signed_artifact(
  p_org_id uuid,
  p_request_id uuid,
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
    and request.delivery_state = 'sent'
    and request.sign_request_id is not null
  for update;
  if not found then
    raise exception 'signed sent eSign request not found' using errcode = 'P0002';
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

revoke all on function public.reconcile_esign_completed_signed_artifact(
  uuid, uuid, uuid, text, text, text, bigint, text, jsonb
) from public, anon, authenticated;
grant execute on function public.reconcile_esign_completed_signed_artifact(
  uuid, uuid, uuid, text, text, text, bigint, text, jsonb
) to service_role;

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
  if v_request.status in ('signed', 'declined', 'voided') then
    return query select 'terminal_ignored'::text, v_request.status; return;
  end if;
  if v_request.status = 'error' and p_requested_status <> 'signed' then
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
    or (v_request.status = 'error'
      and p_requested_status = 'signed'
      and v_request.delivery_state = 'sent'
      and v_request.sign_request_id is not null)
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
        email_update_claim_token = null,
        email_update_claimed_at = null,
        email_update_claim_email = null,
        email_update_claim_actor_id = null,
        updated_at = now()
    where signer.org_id = p_org_id and signer.request_id = p_request_id
      and signer.status <> 'declined';
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
        else null
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
      raise exception 'conflicting eSign material activity event exists'
        using errcode = '23514';
    end if;
  end if;

  return query select 'applied'::text, p_requested_status;
end;
$$;

comment on function public.reconcile_esign_webhook_provider_signers(
  uuid, uuid, uuid, uuid, timestamptz, jsonb, text
) is
  'Service-role verified Dropbox Sign signer truth reconciliation. Updates signer email/signature identity from provider callback signatures and marks signer-level signed callbacks without relying on stale local signature ids.';

comment on function public.reconcile_esign_completed_signed_artifact(
  uuid, uuid, uuid, text, text, text, bigint, text, jsonb
) is
  'Service-role idempotent signed PDF artifact repair for provider-completed eSign requests whose downloadable webhook was already processed before local artifact linkage succeeded.';

comment on function public.apply_esign_webhook_status_decision(
  uuid, uuid, uuid, uuid, public.esign_request_status,
  public.esign_request_status, timestamptz, text, jsonb
) is
  'Service-role verified Dropbox Sign lifecycle transition. Provider all_signed/downloadable truth may recover an ERROR request to signed so signed PDF capture can complete.';

commit;
