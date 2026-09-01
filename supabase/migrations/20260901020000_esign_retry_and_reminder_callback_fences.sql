begin;

-- A failed request is an immutable attempt. Serialize every retry lineage at
-- the database boundary so a double-click or concurrent server invocation can
-- create at most one direct child. A later retry must start from that child if
-- it also reaches the failed state.
create unique index esign_requests_one_retry_child_per_source_idx
  on public.esign_requests (org_id, retry_of_request_id)
  where retry_of_request_id is not null;

-- Dropbox Sign reminder callbacks carry the provider request, provider signer,
-- and provider event time but cannot carry Sandra's private lease token. Lock
-- the verified receipt and signer, snapshot the exact local token/time fence,
-- and clear only that same fence when the callback is not older than the claim.
create or replace function public.reconcile_esign_reminder_callback(
  p_org_id uuid,
  p_request_id uuid,
  p_receipt_id uuid,
  p_lease_id uuid,
  p_provider_signature_id text,
  p_provider_event_at timestamptz
)
returns table (outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt public.esign_webhook_receipts%rowtype;
  v_signer public.esign_request_signers%rowtype;
  v_claim_token uuid;
  v_claimed_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_id is null
     or btrim(coalesce(p_provider_signature_id, '')) = ''
     or p_provider_event_at is null then
    raise exception 'invalid reminder callback identity' using errcode = '22023';
  end if;

  select receipt.* into v_receipt
  from public.esign_webhook_receipts receipt
  where receipt.id = p_receipt_id
    and receipt.org_id = p_org_id
    and receipt.esign_request_id = p_request_id
    and receipt.processing_status = 'processing'
    and receipt.processing_lease_id = p_lease_id
    and receipt.event_type = 'signature_request_remind'
    and receipt.related_signature_id = p_provider_signature_id
    and receipt.provider_event_at = p_provider_event_at
  for update;
  if not found then
    raise exception 'active matching reminder receipt lease not found'
      using errcode = '55000';
  end if;

  select signer.* into v_signer
  from public.esign_request_signers signer
  where signer.org_id = p_org_id
    and signer.request_id = p_request_id
    and signer.provider_signature_id = p_provider_signature_id
  for update;
  if not found then
    raise exception 'eSign request signer not found' using errcode = 'P0002';
  end if;

  if v_signer.reminder_claim_token is null then
    return query select 'already_reconciled'::text;
    return;
  end if;

  -- Provider timestamps have one-second precision. Treat a callback from the
  -- same provider second as not older than the microsecond-precision claim.
  if p_provider_event_at < date_trunc('second', v_signer.reminder_claimed_at) then
    return query select 'stale_ignored'::text;
    return;
  end if;

  v_claim_token := v_signer.reminder_claim_token;
  v_claimed_at := v_signer.reminder_claimed_at;
  update public.esign_request_signers signer
  set last_reminded_at = case
        when signer.last_reminded_at is null
          or signer.last_reminded_at < p_provider_event_at
          then p_provider_event_at
        else signer.last_reminded_at
      end,
      reminder_claim_token = null,
      reminder_claimed_at = null,
      updated_at = now()
  where signer.id = v_signer.id
    and signer.org_id = p_org_id
    and signer.request_id = p_request_id
    and signer.reminder_claim_token = v_claim_token
    and signer.reminder_claimed_at = v_claimed_at;
  if not found then
    return query select 'superseded'::text;
    return;
  end if;

  return query select 'applied'::text;
end;
$$;

revoke all on function public.reconcile_esign_reminder_callback(
  uuid, uuid, uuid, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.reconcile_esign_reminder_callback(
  uuid, uuid, uuid, uuid, text, timestamptz
) to service_role;

comment on function public.reconcile_esign_reminder_callback(
  uuid, uuid, uuid, uuid, text, timestamptz
) is
  'Service-role verified reminder callback reconciliation. Requires the active receipt lease and exact provider signer/time identity; clears only the snapshotted local reminder token/time fence and is idempotent under callback concurrency.';

commit;
