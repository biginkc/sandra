begin;

-- `messages` is a user-visible transport/history table and legacy policies
-- allow an authenticated member to insert and update rows in their
-- organization. It therefore cannot be the authority for rep-SMS replay:
-- an invented row must never make a lost browser response look accepted.
-- This ledger has no browser grants. Its SECURITY DEFINER functions validate
-- the authenticated actor, tenant, lead, sender grant, and full payload before
-- creating or changing a reservation.
create table if not exists public.rep_sms_delivery_ledger (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  submission_key uuid not null,
  property_id uuid not null,
  contact_id uuid not null,
  sender_assignment_id uuid not null,
  obligation_id uuid,
  provider text not null,
  provider_account_id text not null,
  provider_sender_id text not null,
  from_number text not null,
  to_number text not null,
  body text not null,
  state text not null default 'reserved'
    check (state in ('reserved','sending','accepted','delivered','delivery_failed','failed_not_dispatched','unknown','blocked')),
  claim_token uuid not null,
  claim_generation bigint not null default 1 check (claim_generation > 0),
  message_id uuid references public.messages(id) on delete set null,
  provider_message_id text,
  provider_status text,
  provider_error text,
  attempt_count integer not null default 1 check (attempt_count > 0),
  last_pre_dispatch_failure text,
  last_pre_dispatch_failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rep_sms_delivery_ledger_submission_key_idx unique (org_id,submission_key),
  constraint rep_sms_delivery_ledger_phone_check check (
    from_number ~ '^\+[1-9][0-9]{7,14}$' and to_number ~ '^\+[1-9][0-9]{7,14}$'
  ),
  constraint rep_sms_delivery_ledger_claim_state_check check (
    (state in ('reserved','sending','failed_not_dispatched','unknown','blocked') and claim_token is not null)
    or (state in ('accepted','delivered','delivery_failed') and claim_token is not null)
  )
);

create unique index if not exists rep_sms_delivery_ledger_provider_message_idx
  on public.rep_sms_delivery_ledger(provider,provider_account_id,provider_message_id)
  where provider_message_id is not null;
create index if not exists rep_sms_delivery_ledger_lookup_idx
  on public.rep_sms_delivery_ledger(org_id,property_id,actor_user_id,state,updated_at desc);

alter table public.rep_sms_delivery_ledger enable row level security;
revoke all on public.rep_sms_delivery_ledger from public,anon,authenticated,service_role;

create or replace function public.rep_sms_delivery_ledger_touch()
returns trigger language plpgsql set search_path='' as $$
begin
  new.updated_at := statement_timestamp();
  return new;
end;
$$;
revoke all on function public.rep_sms_delivery_ledger_touch() from public,anon,authenticated,service_role;
drop trigger if exists rep_sms_delivery_ledger_touch on public.rep_sms_delivery_ledger;
create trigger rep_sms_delivery_ledger_touch
  before update on public.rep_sms_delivery_ledger
  for each row execute function public.rep_sms_delivery_ledger_touch();

create or replace function public.fn_claim_rep_sms_delivery(
  p_org_id uuid,
  p_actor_id uuid,
  p_submission_key uuid,
  p_property_id uuid,
  p_contact_id uuid,
  p_sender_assignment_id uuid,
  p_provider text,
  p_provider_account_id text,
  p_provider_sender_id text,
  p_from_number text,
  p_to_number text,
  p_body text,
  p_obligation_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_actor uuid := auth.uid();
  v_property public.properties%rowtype;
  v_ledger public.rep_sms_delivery_ledger%rowtype;
  v_token uuid;
begin
  if v_actor is not null and v_actor is distinct from p_actor_id then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if p_org_id is null or p_actor_id is null or p_submission_key is null
    or p_property_id is null or p_contact_id is null or p_sender_assignment_id is null
    or nullif(btrim(p_provider),'') is null
    or nullif(btrim(p_provider_account_id),'') is null
    or nullif(btrim(p_provider_sender_id),'') is null
    or nullif(btrim(p_body),'') is null
    or p_from_number !~ '^\+[1-9][0-9]{7,14}$'
    or p_to_number !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if not exists(
    select 1 from public.memberships m
    where m.org_id=p_org_id and m.user_id=p_actor_id
      and m.access_status='active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at>v_now)
  ) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  select * into v_property from public.properties p
    where p.id=p_property_id and p.org_id=p_org_id and p.deleted_at is null;
  if not found or v_property.homeowner_contact_id is distinct from p_contact_id
    or v_property.assigned_user_id is distinct from p_actor_id
    or v_property.is_dnc_locked then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if not exists(
    select 1 from public.memberships m
    where m.org_id=p_org_id and m.user_id=p_actor_id
      and (m.acquisitions_enabled or m.role='owner')
  ) or not exists(
    select 1 from public.acquisition_assignment_episodes e
    where e.org_id=p_org_id and e.property_id=p_property_id
      and e.assignee_user_id=p_actor_id and e.ended_at is null
  ) or not exists(
    select 1 from public.rep_sms_rollout_enrollments e
    where e.org_id=p_org_id and e.user_id=p_actor_id and e.enabled
  ) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if not exists(
    select 1 from public.contacts c where c.id=p_contact_id and c.org_id=p_org_id
  ) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if not exists(
    select 1 from public.rep_sms_sender_assignments s
    where s.id=p_sender_assignment_id and s.org_id=p_org_id and s.user_id=p_actor_id
      and s.active and s.grant_status='active' and s.revoked_at is null
      and s.provider=lower(btrim(p_provider))
      and s.provider_account_id=btrim(p_provider_account_id)
      and s.provider_sender_id=btrim(p_provider_sender_id)
      and s.phone_e164=p_from_number
  ) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if p_obligation_id is not null and not exists(
    select 1 from public.rep_sms_obligations o
    where o.id=p_obligation_id and o.org_id=p_org_id and o.property_id=p_property_id
      and o.actor_user_id=p_actor_id and o.sender_assignment_id=p_sender_assignment_id
  ) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;

  select * into v_ledger from public.rep_sms_delivery_ledger l
    where l.org_id=p_org_id and l.submission_key=p_submission_key for update;
  if found then
    if v_ledger.actor_user_id is distinct from p_actor_id
      or v_ledger.property_id is distinct from p_property_id
      or v_ledger.contact_id is distinct from p_contact_id
      or v_ledger.sender_assignment_id is distinct from p_sender_assignment_id
      or v_ledger.obligation_id is distinct from p_obligation_id
      or lower(v_ledger.provider) is distinct from lower(btrim(p_provider))
      or v_ledger.provider_account_id is distinct from btrim(p_provider_account_id)
      or v_ledger.provider_sender_id is distinct from btrim(p_provider_sender_id)
      or v_ledger.from_number is distinct from p_from_number
      or v_ledger.to_number is distinct from p_to_number
      or v_ledger.body is distinct from p_body then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001';
    end if;
    if v_ledger.state in ('accepted','delivered','delivery_failed','unknown','blocked') then
      return jsonb_build_object('ok',false,'receiptId',v_ledger.id,'state',v_ledger.state,
        'messageId',v_ledger.message_id,'providerMessageId',v_ledger.provider_message_id,
        'providerError',v_ledger.provider_error,'claimGeneration',v_ledger.claim_generation);
    end if;
    if v_ledger.state in ('reserved','sending') then
      return jsonb_build_object('ok',false,'receiptId',v_ledger.id,'state',v_ledger.state,
        'messageId',v_ledger.message_id,'providerMessageId',v_ledger.provider_message_id,
        'reason','already_in_progress','claimGeneration',v_ledger.claim_generation);
    end if;
    if v_ledger.state <> 'failed_not_dispatched' then
      raise exception 'INVALID_LEDGER_STATE' using errcode='40001';
    end if;
    v_token := extensions.gen_random_uuid();
    update public.rep_sms_delivery_ledger set state='reserved',claim_token=v_token,
      claim_generation=claim_generation+1,attempt_count=attempt_count+1,
      message_id=null,provider_message_id=null,provider_status=null,provider_error=null
      where id=v_ledger.id;
    select * into v_ledger from public.rep_sms_delivery_ledger where id=v_ledger.id;
  else
    v_token := extensions.gen_random_uuid();
    insert into public.rep_sms_delivery_ledger(
      org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,obligation_id,
      provider,provider_account_id,provider_sender_id,from_number,to_number,body,claim_token
    ) values(
      p_org_id,p_actor_id,p_submission_key,p_property_id,p_contact_id,p_sender_assignment_id,p_obligation_id,
      lower(btrim(p_provider)),btrim(p_provider_account_id),btrim(p_provider_sender_id),p_from_number,p_to_number,p_body,v_token
    ) returning * into v_ledger;
  end if;
  return jsonb_build_object('ok',true,'receiptId',v_ledger.id,'state',v_ledger.state,
    'claimToken',v_ledger.claim_token,'claimGeneration',v_ledger.claim_generation,
    'messageId',v_ledger.message_id,'providerMessageId',v_ledger.provider_message_id);
end;
$$;
revoke all on function public.fn_claim_rep_sms_delivery(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,uuid)
  from public,anon,authenticated;
grant execute on function public.fn_claim_rep_sms_delivery(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,uuid)
  to service_role;

create or replace function public.fn_mark_rep_sms_delivery_sending(
  p_receipt_id uuid,p_claim_token uuid,p_claim_generation bigint,p_message_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_l public.rep_sms_delivery_ledger%rowtype; v_m public.messages%rowtype;
begin
  if auth.uid() is not null then raise exception 'Worker authorization is service-only' using errcode='42501'; end if;
  select * into v_l from public.rep_sms_delivery_ledger where id=p_receipt_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','receipt_not_found'); end if;
  if v_l.state='sending' and v_l.claim_token is not distinct from p_claim_token
    and v_l.claim_generation=p_claim_generation and v_l.message_id=p_message_id then
    return jsonb_build_object('ok',true,'receiptId',v_l.id,'state',v_l.state,'claimGeneration',v_l.claim_generation);
  end if;
  if v_l.state<>'reserved' or v_l.claim_token is distinct from p_claim_token
    or v_l.claim_generation<>p_claim_generation then
    return jsonb_build_object('ok',false,'receiptId',v_l.id,'state',v_l.state,'reason','stale_claim');
  end if;
  select * into v_m from public.messages m where m.id=p_message_id
    and m.org_id=v_l.org_id and m.property_id=v_l.property_id and m.contact_id=v_l.contact_id
    and m.channel='sms' and m.direction='outbound' and m.status='pending'
    and m.provider=v_l.provider and m.from_address=v_l.from_number and m.to_address=v_l.to_number
    and m.body=v_l.body;
  if not found then return jsonb_build_object('ok',false,'receiptId',v_l.id,'reason','message_identity_mismatch'); end if;
  update public.rep_sms_delivery_ledger set state='sending',message_id=p_message_id where id=v_l.id;
  return jsonb_build_object('ok',true,'receiptId',v_l.id,'state','sending','claimGeneration',p_claim_generation);
end;
$$;
revoke all on function public.fn_mark_rep_sms_delivery_sending(uuid,uuid,bigint,uuid)
  from public,anon,authenticated;
grant execute on function public.fn_mark_rep_sms_delivery_sending(uuid,uuid,bigint,uuid)
  to service_role;

create or replace function public.fn_record_rep_sms_delivery_result(
  p_receipt_id uuid,p_claim_token uuid,p_claim_generation bigint,p_state text,
  p_provider_message_id text default null,p_provider_status text default null,
  p_provider_error text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_l public.rep_sms_delivery_ledger%rowtype; v_id text:=nullif(btrim(p_provider_message_id),'');
begin
  if auth.uid() is not null then raise exception 'Worker authorization is service-only' using errcode='42501'; end if;
  if p_state not in ('accepted','failed_not_dispatched','unknown','blocked') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select * into v_l from public.rep_sms_delivery_ledger where id=p_receipt_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','receipt_not_found'); end if;
  -- Provider callbacks can win before the accepted result arrives. The stored
  -- terminal state is the truth and the late worker result is a no-op.
  if v_l.state in ('delivered','delivery_failed') and p_state='accepted' then
    if v_id is null or v_l.provider_message_id is distinct from v_id then
      return jsonb_build_object('ok',false,'receiptId',v_l.id,'state',v_l.state,'reason','provider_message_mismatch');
    end if;
    return jsonb_build_object('ok',true,'receiptId',v_l.id,'state',v_l.state,'duplicate',true,
      'messageId',v_l.message_id,'providerMessageId',v_l.provider_message_id);
  end if;
  if v_l.claim_token is distinct from p_claim_token or v_l.claim_generation<>p_claim_generation then
    return jsonb_build_object('ok',false,'receiptId',v_l.id,'state',v_l.state,'reason','stale_claim');
  end if;
  if p_state='accepted' then
    if v_l.state<>'sending' or v_id is null then
      raise exception 'ACCEPTED_REQUIRES_SENDING_AND_PROVIDER_ID' using errcode='40001';
    end if;
    -- Provider message ids are global within a provider account. Return a
    -- deterministic collision result before the unique index can abort the
    -- worker transaction and leave delivery reconciliation ambiguous.
    if exists(
      select 1 from public.rep_sms_delivery_ledger other
      where lower(other.provider)=lower(v_l.provider)
        and other.provider_account_id=v_l.provider_account_id
        and other.provider_message_id=v_id
        and other.id is distinct from v_l.id
    ) then
      return jsonb_build_object('ok',false,'receiptId',v_l.id,'state',v_l.state,
        'reason','provider_message_id_already_bound','providerMessageIdAlreadyBound',true);
    end if;
    update public.rep_sms_delivery_ledger set state='accepted',provider_message_id=v_id,
      provider_status=nullif(btrim(p_provider_status),''),provider_error=null where id=v_l.id;
  elsif p_state='failed_not_dispatched' then
    if v_l.state not in ('reserved','sending') or nullif(btrim(coalesce(p_provider_error,'')),'') is null then
      raise exception 'FAILURE_REQUIRES_RESERVED_AND_REASON' using errcode='40001';
    end if;
    update public.rep_sms_delivery_ledger set state='failed_not_dispatched',provider_error=btrim(p_provider_error),
      last_pre_dispatch_failure=btrim(p_provider_error),last_pre_dispatch_failed_at=statement_timestamp(),
      provider_message_id=null,provider_status=null where id=v_l.id;
  elsif p_state='blocked' then
    if v_l.state not in ('reserved','sending') or nullif(btrim(coalesce(p_provider_error,'')),'') is null then
      raise exception 'FAILURE_REQUIRES_RESERVED_AND_REASON' using errcode='40001';
    end if;
    update public.rep_sms_delivery_ledger set state='blocked',provider_error=btrim(p_provider_error) where id=v_l.id;
  else
    if v_l.state not in ('sending','accepted','unknown') then
      raise exception 'INVALID_LEDGER_STATE' using errcode='40001';
    end if;
    update public.rep_sms_delivery_ledger set state='unknown',provider_message_id=coalesce(v_id,provider_message_id),
      provider_status=nullif(btrim(p_provider_status),''),provider_error=nullif(btrim(p_provider_error),'') where id=v_l.id;
  end if;
  select * into v_l from public.rep_sms_delivery_ledger where id=v_l.id;
  return jsonb_build_object('ok',true,'receiptId',v_l.id,'state',v_l.state,'messageId',v_l.message_id,
    'providerMessageId',v_l.provider_message_id,'providerError',v_l.provider_error,
    'claimGeneration',v_l.claim_generation);
end;
$$;
revoke all on function public.fn_record_rep_sms_delivery_result(uuid,uuid,bigint,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.fn_record_rep_sms_delivery_result(uuid,uuid,bigint,text,text,text,text)
  to service_role;

create or replace function public.fn_record_rep_sms_delivery_ledger_callback(
  p_provider text,p_provider_account_id text,p_provider_message_id text,p_state text,
  p_provider_status text default null,p_provider_error text default null,p_metadata jsonb default '{}'::jsonb,
  p_org_id uuid default null,p_receipt_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_l public.rep_sms_delivery_ledger%rowtype; v_exact boolean:=p_org_id is not null or p_receipt_id is not null;
begin
  if auth.uid() is not null then raise exception 'Provider callbacks are service-only' using errcode='42501'; end if;
  if nullif(btrim(p_provider),'') is null or nullif(btrim(p_provider_account_id),'') is null
    or nullif(btrim(p_provider_message_id),'') is null or p_state not in ('delivered','delivery_failed') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if v_exact and (p_org_id is null or p_receipt_id is null) then
    raise exception 'EXACT_RECEIPT_REQUIRES_ORG' using errcode='22023';
  end if;
  if v_exact then
    select * into v_l from public.rep_sms_delivery_ledger
      where id=p_receipt_id and org_id=p_org_id for update;
    if not found then return jsonb_build_object('ok',false,'matched',false,'reason','receipt_not_found'); end if;
    if lower(v_l.provider) is distinct from lower(btrim(p_provider))
      or v_l.provider_account_id is distinct from btrim(p_provider_account_id)
      or (v_l.provider_message_id is not null and v_l.provider_message_id is distinct from btrim(p_provider_message_id)) then
      return jsonb_build_object('ok',false,'matched',false,'identityMismatch',true);
    end if;
    -- The receipt id is stored in a browser-visible message metadata object,
    -- so it is not sufficient by itself. The service callback must also name
    -- the exact history row that the worker fenced before provider dispatch.
    if v_l.message_id is null
      or p_metadata->>'messageId' is distinct from v_l.message_id::text then
      return jsonb_build_object('ok',false,'matched',false,'identityMismatch',true);
    end if;
    -- Provider message ids are scoped by provider account globally. Do this
    -- check before the update so a cross-org collision is a safe no-op rather
    -- than a unique-index exception that leaves callback processing ambiguous.
    if v_l.provider_message_id is null and exists(
      select 1 from public.rep_sms_delivery_ledger other
      where lower(other.provider)=lower(btrim(p_provider))
        and other.provider_account_id=btrim(p_provider_account_id)
        and other.provider_message_id=btrim(p_provider_message_id)
        and other.id is distinct from v_l.id
    ) then
      return jsonb_build_object('ok',false,'matched',false,'identityMismatch',true,
        'providerMessageIdAlreadyBound',true);
    end if;
    -- An unknown receipt with no provider id has no evidence tying this
    -- callback to the original request. The exact receipt/message overload
    -- is only a bridge for an in-flight send and must not settle an
    -- ambiguous row from tenant or message payload fields alone.
    if v_l.state='unknown' and v_l.provider_message_id is null then
      return jsonb_build_object('ok',false,'matched',false,
        'reason','provider_message_id_missing');
    end if;
  else
    select * into v_l from public.rep_sms_delivery_ledger
      where lower(provider)=lower(btrim(p_provider))
        and provider_account_id=btrim(p_provider_account_id)
        and provider_message_id=btrim(p_provider_message_id) for update;
    if not found then return jsonb_build_object('ok',false,'matched',false); end if;
  end if;
  if p_state='delivery_failed' and nullif(btrim(coalesce(p_provider_error,'')),'') is null then
    raise exception 'FAILURE_REQUIRES_REASON' using errcode='22023';
  end if;
  if v_l.state in ('delivered','delivery_failed') then
    return jsonb_build_object('ok',true,'matched',true,'duplicate',true,'state',v_l.state,
      'receiptId',v_l.id,'providerMessageId',v_l.provider_message_id);
  end if;
  if v_l.state not in ('sending','accepted','unknown') then
    return jsonb_build_object('ok',false,'matched',true,'state',v_l.state,'reason','callback_state_not_settleable');
  end if;
  update public.rep_sms_delivery_ledger set state=p_state,provider_message_id=btrim(p_provider_message_id),
    provider_status=coalesce(nullif(btrim(p_provider_status),''),provider_status),
    provider_error=coalesce(nullif(btrim(p_provider_error),''),provider_error)
    where id=v_l.id;
  select * into v_l from public.rep_sms_delivery_ledger where id=v_l.id;
  return jsonb_build_object('ok',true,'matched',true,'state',v_l.state,'receiptId',v_l.id,
    'providerMessageId',v_l.provider_message_id);
end;
$$;
revoke all on function public.fn_record_rep_sms_delivery_ledger_callback(text,text,text,text,text,text,jsonb,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.fn_record_rep_sms_delivery_ledger_callback(text,text,text,text,text,text,jsonb,uuid,uuid)
  to service_role;

commit;
