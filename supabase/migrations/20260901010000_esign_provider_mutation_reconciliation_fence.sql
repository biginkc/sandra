begin;

-- A provider mutation may have succeeded even when Sandra could not finalize
-- its bookkeeping. Once a reminder/void lease becomes stale, a new provider
-- call is therefore unsafe. Preserve the exact claim as a reconciliation fence
-- until an operator or verified provider callback resolves it.

create or replace function public.claim_esign_signer_reminder(
  p_org_id uuid,
  p_request_id uuid,
  p_signer_id uuid,
  p_claim_token uuid
)
returns table (
  outcome text,
  provider_request_id text,
  provider_signature_id text,
  signer_name text,
  signer_email text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_signer public.esign_request_signers%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_claim_token is null then
    raise exception 'invalid reminder lease' using errcode = '22023';
  end if;

  select * into v_request
  from public.esign_requests request
  where request.id = p_request_id and request.org_id = p_org_id
  for update;
  if not found then
    raise exception 'eSign request not found' using errcode = 'P0002';
  end if;

  if v_request.void_claim_token is not null then
    return query select
      case
        when v_request.void_claimed_at > now() - interval '10 minutes'
          then 'in_progress'::text
        else 'reconciliation_required'::text
      end,
      null::text, null::text, null::text, null::text;
    return;
  end if;

  select * into v_signer
  from public.esign_request_signers signer
  where signer.id = p_signer_id
    and signer.org_id = p_org_id
    and signer.request_id = p_request_id
  for update;
  if not found then
    raise exception 'eSign request signer not found' using errcode = 'P0002';
  end if;

  if v_request.delivery_state <> 'sent'
     or v_request.status not in ('awaiting', 'viewed')
     or v_request.sign_request_id is null
     or v_request.void_requested_at is not null
     or v_signer.status not in ('awaiting', 'viewed')
     or v_signer.provider_signature_id is null
     or exists (
       select 1
       from public.esign_request_signers earlier
       where earlier.org_id = p_org_id
         and earlier.request_id = p_request_id
         and earlier.signer_order < v_signer.signer_order
         and earlier.status <> 'signed'
     ) then
    return query select 'ineligible'::text,
      null::text, null::text, null::text, null::text;
    return;
  end if;

  if v_signer.last_reminded_at is not null
     and v_signer.last_reminded_at > now() - interval '1 hour' then
    return query select 'cooldown'::text,
      null::text, null::text, null::text, null::text;
    return;
  end if;

  if v_signer.reminder_claim_token is not null then
    return query select
      case
        when v_signer.reminder_claimed_at > now() - interval '10 minutes'
          then 'in_progress'::text
        else 'reconciliation_required'::text
      end,
      null::text, null::text, null::text, null::text;
    return;
  end if;

  update public.esign_request_signers
  set reminder_claim_token = p_claim_token,
      reminder_claimed_at = now(),
      updated_at = now()
  where id = p_signer_id
    and org_id = p_org_id
    and request_id = p_request_id;

  return query select 'claimed'::text,
    v_request.sign_request_id,
    v_signer.provider_signature_id,
    v_signer.signer_name,
    v_signer.signer_email;
end;
$$;

create or replace function public.claim_esign_request_void(
  p_org_id uuid,
  p_request_id uuid,
  p_claim_token uuid
)
returns table (outcome text, provider_request_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_claim_token is null then
    raise exception 'invalid void lease' using errcode = '22023';
  end if;

  select * into v_request
  from public.esign_requests request
  where request.id = p_request_id and request.org_id = p_org_id
  for update;
  if not found then
    raise exception 'eSign request not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.esign_request_signers signer
    where signer.org_id = p_org_id
      and signer.request_id = p_request_id
      and signer.reminder_claim_token is not null
  ) then
    return query select
      case
        when exists (
          select 1
          from public.esign_request_signers signer
          where signer.org_id = p_org_id
            and signer.request_id = p_request_id
            and signer.reminder_claim_token is not null
            and signer.reminder_claimed_at <= now() - interval '10 minutes'
        ) then 'reconciliation_required'::text
        else 'in_progress'::text
      end,
      null::text;
    return;
  end if;

  if v_request.delivery_state <> 'sent'
     or v_request.status not in ('awaiting', 'viewed')
     or v_request.sign_request_id is null
     or v_request.void_requested_at is not null then
    return query select 'ineligible'::text, null::text;
    return;
  end if;

  if v_request.void_claim_token is not null then
    return query select
      case
        when v_request.void_claimed_at > now() - interval '10 minutes'
          then 'in_progress'::text
        else 'reconciliation_required'::text
      end,
      null::text;
    return;
  end if;

  update public.esign_requests
  set void_claim_token = p_claim_token,
      void_claimed_at = now(),
      updated_at = now()
  where id = p_request_id and org_id = p_org_id;

  return query select 'claimed'::text, v_request.sign_request_id;
end;
$$;

revoke all on function public.claim_esign_signer_reminder(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.claim_esign_signer_reminder(
  uuid, uuid, uuid, uuid
) to service_role;

revoke all on function public.claim_esign_request_void(
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.claim_esign_request_void(
  uuid, uuid, uuid
) to service_role;

comment on function public.claim_esign_signer_reminder(
  uuid, uuid, uuid, uuid
) is
  'Service-role reminder claim. Active claims return in_progress; stale claims remain fenced and return reconciliation_required. Never auto-reclaims a provider mutation.';

comment on function public.claim_esign_request_void(
  uuid, uuid, uuid
) is
  'Service-role void claim. Active claims return in_progress; stale reminder or void claims remain fenced and return reconciliation_required. Never auto-reclaims a provider mutation.';

commit;
