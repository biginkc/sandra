begin;

-- Preserve pre-repair timestamps and identity snapshots before final reconciliation.
create table if not exists public.esign_completion_reconciliation_audits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  request_id uuid not null,
  receipt_id uuid not null,
  request_snapshot jsonb not null,
  signer_snapshot jsonb not null,
  reconciled_at timestamptz not null default now(),
  foreign key (request_id, org_id) references public.esign_requests(id, org_id),
  unique (org_id, request_id)
);
alter table public.esign_completion_reconciliation_audits enable row level security;
revoke all on public.esign_completion_reconciliation_audits from public, anon, authenticated, service_role;
grant select, insert on public.esign_completion_reconciliation_audits to service_role;

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
  if v_receipt.event_type = 'signature_request_all_signed' then
    -- The server obtains this snapshot from signature_request/get after exact
    -- provider/local-request and mode checks. Never infer identity from order.
    if jsonb_array_length(v_signatures) = 0 or exists (
      select 1 from jsonb_array_elements(v_signatures) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or btrim(coalesce(item.value ->> 'signatureId', '')) = ''
        or item.value ->> 'statusCode' is distinct from 'signed'
        or coalesce(item.value ->> 'signedAt', '') !~ '^[0-9]+$'
    ) then
      raise exception 'complete provider signer evidence required' using errcode = '23514';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_signatures) item(value)
      where (item.value ->> 'signedAt')::numeric <= 0
        or (item.value ->> 'signedAt')::numeric > extract(epoch from p_provider_event_at)
    ) or (
      select count(distinct item.value ->> 'signatureId')
      from jsonb_array_elements(v_signatures) item(value)
    ) <> jsonb_array_length(v_signatures) or (
      select count(*) from public.esign_request_signers signer
      where signer.org_id = p_org_id and signer.request_id = p_request_id
    ) <> jsonb_array_length(v_signatures) or exists (
      select 1 from public.esign_request_signers signer
      where signer.org_id = p_org_id and signer.request_id = p_request_id
        and not exists (
          select 1 from jsonb_array_elements(v_signatures) item(value)
          where item.value ->> 'signatureId' = signer.provider_signature_id
        )
    ) then
      raise exception 'complete provider signer set did not match persisted IDs' using errcode = '23514';
    end if;

    insert into public.esign_completion_reconciliation_audits
      (org_id, request_id, receipt_id, request_snapshot, signer_snapshot)
    select p_org_id, p_request_id, p_receipt_id, to_jsonb(v_request),
      coalesce(jsonb_agg(to_jsonb(signer) order by signer.signer_order), '[]'::jsonb)
    from public.esign_request_signers signer
    where signer.org_id = p_org_id and signer.request_id = p_request_id
    on conflict (org_id, request_id) do nothing;

    update public.esign_request_signers signer
    set status = 'signed',
        signed_at = to_timestamp((item.value ->> 'signedAt')::double precision),
        viewed_at = least(coalesce(signer.viewed_at, to_timestamp((item.value ->> 'signedAt')::double precision)), to_timestamp((item.value ->> 'signedAt')::double precision)),
        reminder_claim_token = null, reminder_claimed_at = null,
        updated_at = now()
    from jsonb_array_elements(v_signatures) item(value)
    where signer.org_id = p_org_id and signer.request_id = p_request_id
      and signer.provider_signature_id = item.value ->> 'signatureId';
    update public.esign_webhook_receipts set esign_request_id = p_request_id
    where id = p_receipt_id and org_id = p_org_id;
    return query select 'applied'::text;
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
        updated_at = now()
    where signer.org_id = p_org_id
      and signer.request_id = p_request_id
      and signer.role_name = v_signature.role_name
      and signer.signer_order = v_signature.signer_order
      and (
        signer.provider_signature_id is distinct from v_signature.signature_id
        or signer.signer_email is distinct from v_signature.signer_email
        or signer.signer_name is distinct from v_signature.signer_name
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

commit;
