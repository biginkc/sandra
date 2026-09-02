begin;

alter table public.esign_request_signers
  add column if not exists email_update_claim_token uuid,
  add column if not exists email_update_claimed_at timestamptz,
  add column if not exists email_update_claim_email text,
  add column if not exists email_update_claim_actor_id uuid references auth.users(id);

alter table public.esign_request_signers
  drop constraint if exists esign_request_signers_email_update_claim_check;
alter table public.esign_request_signers
  add constraint esign_request_signers_email_update_claim_check check (
    (
      email_update_claim_token is null
      and email_update_claimed_at is null
      and email_update_claim_email is null
      and email_update_claim_actor_id is null
    )
    or (
      email_update_claim_token is not null
      and email_update_claimed_at is not null
      and btrim(coalesce(email_update_claim_email, '')) ~ '^[^[:space:]@]+@[^[:space:]@]+$'
      and email_update_claim_actor_id is not null
    )
  );

alter table public.esign_requests
  drop constraint if exists esign_requests_delivery_check;
alter table public.esign_requests
  add constraint esign_requests_delivery_check check (
    (delivery_state = 'sending' and sign_request_id is null and sent_at is null)
    or (delivery_state = 'sent' and sign_request_id is not null and sent_at is not null)
    or (delivery_state = 'send_unknown')
    or (delivery_state = 'failed' and error_message is not null)
    or (
      delivery_state = 'email_bounced'
      and status = 'error'
      and sign_request_id is not null
      and sent_at is not null
      and error_message = 'PROVIDER_EMAIL_BOUNCE'
    )
  );

comment on column public.esign_request_signers.email_update_claim_token is
  'Fencing token for updating a bounced Dropbox Sign signer email on the existing provider request.';
comment on column public.esign_request_signers.email_update_claim_email is
  'Pending corrected signer email. Cleared after provider update acceptance or definitive failure.';

create or replace function public.apply_esign_email_bounce_delivery_decision(
  p_org_id uuid,
  p_request_id uuid,
  p_receipt_id uuid,
  p_lease_id uuid,
  p_expected_status public.esign_request_status,
  p_provider_event_at timestamptz
)
returns table (outcome text, status public.esign_request_status)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_receipt public.esign_webhook_receipts%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider_event_at is null then
    raise exception 'invalid provider bounce decision' using errcode = '22023';
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
    and receipt.event_type = 'signature_request_email_bounce'
    and receipt.sign_request_id = v_request.sign_request_id
    and receipt.provider_event_at is not distinct from p_provider_event_at
    and (receipt.esign_request_id = p_request_id or receipt.esign_request_id is null)
  for update;
  if not found then
    raise exception 'active matching bounce receipt lease not found'
      using errcode = 'P0002';
  end if;

  if v_request.status in ('signed', 'declined', 'voided') then
    return query select 'terminal_ignored'::text, v_request.status;
    return;
  end if;
  if v_request.delivery_state = 'email_bounced' and v_request.status = 'error' then
    return query select 'no_change'::text, v_request.status;
    return;
  end if;
  if v_request.status <> p_expected_status
     or (v_request.provider_event_at is not null
       and p_provider_event_at < v_request.provider_event_at)
     or v_request.delivery_state not in ('sent', 'send_unknown')
     or v_request.sign_request_id is null
     or v_request.sent_at is null then
    return query select 'no_change'::text, v_request.status;
    return;
  end if;
  if not (
    (v_request.status = 'awaiting')
    or (v_request.status = 'viewed')
    or (v_request.status = 'error' and v_request.error_message is distinct from 'PROVIDER_EMAIL_BOUNCE')
  ) then
    return query select 'no_change'::text, v_request.status;
    return;
  end if;

  update public.esign_request_signers signer
  set status = 'error',
      reminder_claim_token = null,
      reminder_claimed_at = null,
      email_update_claim_token = null,
      email_update_claimed_at = null,
      email_update_claim_email = null,
      email_update_claim_actor_id = null,
      updated_at = now()
  where signer.org_id = p_org_id
    and signer.request_id = p_request_id
    and signer.status not in ('signed', 'declined')
    and (
      v_receipt.related_signature_id is null
      or signer.provider_signature_id = v_receipt.related_signature_id
    );
  if not found then
    raise exception 'matching bounced eSign signer not found'
      using errcode = 'P0002';
  end if;

  update public.esign_webhook_receipts
  set esign_request_id = p_request_id
  where id = p_receipt_id and org_id = p_org_id;

  update public.esign_requests
  set status = 'error',
      delivery_state = 'email_bounced',
      provider_event_at = greatest(
        coalesce(provider_event_at, p_provider_event_at),
        p_provider_event_at
      ),
      completed_at = p_provider_event_at,
      void_claim_token = null,
      void_claimed_at = null,
      error_message = 'PROVIDER_EMAIL_BOUNCE',
      updated_by = null,
      updated_at = now()
  where id = p_request_id and org_id = p_org_id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    p_org_id,
    v_request.property_id,
    'system',
    null,
    'esign_email_bounced',
    jsonb_build_object('request_id', p_request_id),
    'esign_email_bounce_receipt',
    p_receipt_id
  ) on conflict (source_type, source_id) where source_id is not null do nothing;

  return query select 'applied'::text, 'error'::public.esign_request_status;
end;
$$;

revoke all on function public.apply_esign_email_bounce_delivery_decision(
  uuid, uuid, uuid, uuid, public.esign_request_status, timestamptz
) from public, anon, authenticated;
grant execute on function public.apply_esign_email_bounce_delivery_decision(
  uuid, uuid, uuid, uuid, public.esign_request_status, timestamptz
) to service_role;

create or replace function public.claim_esign_bounced_signer_email_update(
  p_org_id uuid,
  p_request_id uuid,
  p_signer_id uuid,
  p_actor_id uuid,
  p_email_address text,
  p_claim_token uuid
)
returns table (
  outcome text,
  provider_request_id text,
  provider_signature_id text,
  signer_role text,
  signer_order integer,
  signer_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_signer public.esign_request_signers%rowtype;
  v_contact_id uuid;
  v_current_contact_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_claim_token is null
     or btrim(coalesce(p_email_address, '')) !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception 'invalid bounced signer email update claim'
      using errcode = '23514';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);

  select request.claimed_homeowner_contact_id, property.homeowner_contact_id
  into v_contact_id, v_current_contact_id
  from public.esign_requests request
  join public.properties property
    on property.id = request.property_id and property.org_id = request.org_id
  where request.id = p_request_id and request.org_id = p_org_id;
  if not found then
    return query select 'ineligible'::text, null::text, null::text, null::text, null::integer, null::text;
    return;
  end if;

  if v_contact_id is not null then
    perform 1
    from public.contacts contact
    where contact.id = v_contact_id and contact.org_id = p_org_id
    for update;
    if not found then
      return query select 'ineligible'::text, null::text, null::text, null::text, null::integer, null::text;
      return;
    end if;
  end if;

  select property.homeowner_contact_id into v_current_contact_id
  from public.properties property
  where property.id = (
    select request.property_id
    from public.esign_requests request
    where request.id = p_request_id and request.org_id = p_org_id
  )
    and property.org_id = p_org_id
  for update;
  if not found
     or (v_contact_id is not null and v_current_contact_id is distinct from v_contact_id) then
    return query select 'ineligible'::text, null::text, null::text, null::text, null::integer, null::text;
    return;
  end if;

  select request.* into v_request
  from public.esign_requests request
  where request.id = p_request_id and request.org_id = p_org_id
  for update;
  if not found then
    return query select 'ineligible'::text, null::text, null::text, null::text, null::integer, null::text;
    return;
  end if;

  select signer.* into v_signer
  from public.esign_request_signers signer
  where signer.id = p_signer_id
    and signer.org_id = p_org_id
    and signer.request_id = p_request_id
  for update;
  if not found then
    return query select 'ineligible'::text, null::text, null::text, null::text, null::integer, null::text;
    return;
  end if;

  if v_signer.email_update_claim_token is not null then
    if v_signer.email_update_claimed_at > now() - interval '10 minutes' then
      return query select 'in_progress'::text, null::text, null::text, null::text, null::integer, null::text;
    else
      return query select 'reconciliation_required'::text, null::text, null::text, null::text, null::integer, null::text;
    end if;
    return;
  end if;

  if v_request.status <> 'error'
     or v_request.delivery_state <> 'email_bounced'
     or v_request.sign_request_id is null
     or not v_request.test_mode
     or v_request.void_requested_at is not null
     or v_signer.status <> 'error'
     or btrim(coalesce(v_signer.provider_signature_id, '')) = ''
     or lower(btrim(v_signer.signer_email)) = lower(btrim(p_email_address)) then
    return query select 'ineligible'::text, null::text, null::text, null::text, null::integer, null::text;
    return;
  end if;

  update public.esign_request_signers signer
  set email_update_claim_token = p_claim_token,
      email_update_claimed_at = now(),
      email_update_claim_email = btrim(p_email_address),
      email_update_claim_actor_id = p_actor_id,
      updated_at = now()
  where signer.id = p_signer_id
    and signer.org_id = p_org_id
    and signer.request_id = p_request_id
    and signer.email_update_claim_token is null;
  if not found then
    return query select 'in_progress'::text, null::text, null::text, null::text, null::integer, null::text;
    return;
  end if;

  return query select
    'claimed'::text,
    v_request.sign_request_id,
    v_signer.provider_signature_id,
    v_signer.role_name,
    v_signer.signer_order,
    v_signer.signer_name;
end;
$$;

revoke all on function public.claim_esign_bounced_signer_email_update(
  uuid, uuid, uuid, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.claim_esign_bounced_signer_email_update(
  uuid, uuid, uuid, uuid, text, uuid
) to service_role;

create or replace function public.finalize_esign_bounced_signer_email_update(
  p_org_id uuid,
  p_request_id uuid,
  p_signer_id uuid,
  p_claim_token uuid,
  p_provider_signature_id text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_signer public.esign_request_signers%rowtype;
  v_current_homeowner_contact_id uuid;
  v_target_contact_available boolean := false;
  v_target_contact_current boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_claim_token is null or btrim(coalesce(p_provider_signature_id, '')) = '' then
    raise exception 'invalid bounced signer email update finalization'
      using errcode = '23514';
  end if;

  select request.* into v_request
  from public.esign_requests request
  where request.id = p_request_id
    and request.org_id = p_org_id
    and request.status = 'error'
    and request.delivery_state = 'email_bounced';
  if not found then
    return 'lease_lost';
  end if;

  if v_request.claimed_homeowner_contact_id is not null then
    perform 1 from public.contacts contact
    where contact.id = v_request.claimed_homeowner_contact_id
      and contact.org_id = p_org_id
    for update;
    v_target_contact_available := found;
  end if;
  select property.homeowner_contact_id into v_current_homeowner_contact_id
  from public.properties property
  where property.id = v_request.property_id and property.org_id = p_org_id
  for update;
  v_target_contact_current := found
    and v_request.claimed_homeowner_contact_id is not null
    and v_current_homeowner_contact_id is not distinct from v_request.claimed_homeowner_contact_id;

  select request.* into v_request
  from public.esign_requests request
  where request.id = p_request_id
    and request.org_id = p_org_id
    and request.status = 'error'
    and request.delivery_state = 'email_bounced'
  for update;
  if not found then
    return 'lease_lost';
  end if;

  select signer.* into v_signer
  from public.esign_request_signers signer
  where signer.id = p_signer_id
    and signer.org_id = p_org_id
    and signer.request_id = p_request_id
    and signer.email_update_claim_token = p_claim_token
  for update;
  if not found then
    return 'lease_lost';
  end if;

  update public.esign_request_signers signer
  set signer_email = v_signer.email_update_claim_email,
      provider_signature_id = btrim(p_provider_signature_id),
      status = 'awaiting',
      viewed_at = null,
      signed_at = null,
      declined_at = null,
      reminder_claim_token = null,
      reminder_claimed_at = null,
      email_update_claim_token = null,
      email_update_claimed_at = null,
      email_update_claim_email = null,
      email_update_claim_actor_id = null,
      updated_at = now()
  where signer.id = p_signer_id
    and signer.org_id = p_org_id
    and signer.request_id = p_request_id
    and signer.email_update_claim_token = p_claim_token;
  if not found then
    return 'lease_lost';
  end if;

  update public.esign_requests request
  set status = 'awaiting',
      delivery_state = 'sent',
      completed_at = null,
      error_message = null,
      updated_by = v_signer.email_update_claim_actor_id,
      updated_at = now()
  where request.id = p_request_id
    and request.org_id = p_org_id
    and request.status = 'error'
    and request.delivery_state = 'email_bounced';
  if not found then
    return 'lease_lost';
  end if;

  begin
    update public.contacts
    set email = v_signer.email_update_claim_email
    where id = v_request.claimed_homeowner_contact_id
      and org_id = p_org_id
      and v_target_contact_available
      and v_target_contact_current;
    if not found then
      insert into public.lead_events (
        org_id, property_id, actor_type, actor_id, event_type, payload,
        source_type, source_id
      ) values (
        p_org_id, v_request.property_id, 'system', null,
        'esign_contact_email_persist_skipped',
        jsonb_build_object(
          'reason',
          case
            when v_request.claimed_homeowner_contact_id is null
              then 'missing_claimed_contact_snapshot'
            when not v_target_contact_available then 'claimed_contact_missing'
            when not v_target_contact_current then 'property_homeowner_changed'
            else 'contact_update_not_applied'
          end,
          'claimed_homeowner_contact_id', v_request.claimed_homeowner_contact_id,
          'current_homeowner_contact_id', v_current_homeowner_contact_id
        ),
        'esign_contact_email_persist',
        p_request_id
      ) on conflict (source_type, source_id) where source_id is not null do nothing;
    end if;
  exception
    when unique_violation then
      insert into public.lead_events (
        org_id, property_id, actor_type, actor_id, event_type, payload,
        source_type, source_id
      ) values (
        p_org_id, v_request.property_id, 'system', null,
        'esign_contact_email_persist_skipped',
        jsonb_build_object(
          'reason', 'seller_email_conflict',
          'claimed_homeowner_contact_id', v_request.claimed_homeowner_contact_id
        ),
        'esign_contact_email_persist',
        p_request_id
      ) on conflict (source_type, source_id) where source_id is not null do nothing;
  end;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    p_org_id,
    v_request.property_id,
    'user',
    v_signer.email_update_claim_actor_id,
    'esign_email_bounced_resend',
    jsonb_build_object(
      'request_id', p_request_id,
      'signer_id', p_signer_id,
      'signer_role', v_signer.role_name,
      'provider_request_id', v_request.sign_request_id,
      'provider_signature_id', btrim(p_provider_signature_id)
    ),
    null,
    null
  );

  return 'applied';
end;
$$;

revoke all on function public.finalize_esign_bounced_signer_email_update(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.finalize_esign_bounced_signer_email_update(
  uuid, uuid, uuid, uuid, text
) to service_role;

create or replace function public.release_esign_bounced_signer_email_update(
  p_org_id uuid,
  p_request_id uuid,
  p_signer_id uuid,
  p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_claim_token is null then
    raise exception 'invalid bounced signer email update release'
      using errcode = '23514';
  end if;

  update public.esign_request_signers signer
  set email_update_claim_token = null,
      email_update_claimed_at = null,
      email_update_claim_email = null,
      email_update_claim_actor_id = null,
      updated_at = now()
  where signer.id = p_signer_id
    and signer.org_id = p_org_id
    and signer.request_id = p_request_id
    and signer.email_update_claim_token = p_claim_token;
  if not found then
    return 'lease_lost';
  end if;
  return 'released';
end;
$$;

revoke all on function public.release_esign_bounced_signer_email_update(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.release_esign_bounced_signer_email_update(
  uuid, uuid, uuid, uuid
) to service_role;

comment on function public.apply_esign_email_bounce_delivery_decision(
  uuid, uuid, uuid, uuid, public.esign_request_status, timestamptz
) is
  'Service-role verified Dropbox Sign email-bounce transition. Marks the existing provider request undeliverable without creating a retry request.';
comment on function public.claim_esign_bounced_signer_email_update(
  uuid, uuid, uuid, uuid, text, uuid
) is
  'Service-role owner-gated claim for updating a bounced signer email on the existing Dropbox Sign request. Locks contact before property before request.';
comment on function public.finalize_esign_bounced_signer_email_update(
  uuid, uuid, uuid, uuid, text
) is
  'Service-role finalization for accepted Dropbox Sign signer email update. Restores delivery_state=sent on the same local/provider request and persists the confirmed seller email with the send-time contact snapshot guard.';

commit;
