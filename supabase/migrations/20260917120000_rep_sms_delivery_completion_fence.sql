begin;

-- A delivery failure callback is authoritative provider evidence. Keep the
-- worker's claim token as an immutable completion fence so a late accepted
-- response from the same send can acknowledge the already-terminal row
-- without reopening it or dispatching a second SMS.
alter table public.rep_sms_obligations
  drop constraint if exists rep_sms_obligations_claim_lifecycle_check;

alter table public.rep_sms_obligations
  drop constraint if exists rep_sms_obligations_terminal_check;

-- Rows created by the first version of the callback bridge may already be
-- delivery_failed with the old unclaimed shape. Preserve those outcomes and
-- mint a durable fence before tightening the lifecycle contract.
update public.rep_sms_obligations
set claim_state='complete',
    claim_token=coalesce(claim_token,extensions.gen_random_uuid()),
    lease_expires_at=null,
    resolved_at=coalesce(resolved_at,updated_at,statement_timestamp())
where state='delivery_failed'
  and (claim_state<>'complete' or claim_token is null);

alter table public.rep_sms_obligations
  add constraint rep_sms_obligations_claim_lifecycle_check
  check (
    (claim_state='unclaimed' and state in ('required','draft','failed_not_dispatched','unknown','blocked')
      and claim_token is null and claimed_by is null
      and claimed_at is null and lease_expires_at is null)
    or (claim_state='claimed' and state in ('claimed','sending') and claim_token is not null and claimed_by is not null
      and claimed_at is not null and lease_expires_at is not null)
    or (claim_state='complete' and state in ('accepted','delivered','delivery_failed','voided','exception_closed')
      and claim_token is not null)
  );

alter table public.rep_sms_obligations
  add constraint rep_sms_obligations_terminal_check
  check (
    (state in ('delivered','delivery_failed','voided','exception_closed') and claim_state='complete')
    or state not in ('delivered','delivery_failed','voided','exception_closed')
  );

-- The owner correction RPC intentionally moves a proven pre-dispatch failure
-- back to draft. The original guard omitted that legal repair transition,
-- which made `retry` fail even though fn_owner_correct_rep_sms_obligation
-- admitted failed_not_dispatched.
create or replace function public.rep_sms_obligation_transition_guard()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.state is distinct from old.state then
    if not (
      (old.state='required' and new.state in ('draft','claimed','sending','blocked','voided','exception_closed'))
      or (old.state='draft' and new.state in ('claimed','sending','blocked','voided','exception_closed'))
      or (old.state='claimed' and new.state in ('sending','failed_not_dispatched','unknown','blocked','voided','exception_closed'))
      or (old.state='sending' and new.state in ('accepted','delivered','delivery_failed','failed_not_dispatched','unknown','blocked','voided','exception_closed'))
      or (old.state='accepted' and new.state in ('delivered','delivery_failed','unknown','voided','exception_closed'))
      or (old.state='failed_not_dispatched' and new.state in ('draft','claimed','sending','voided','exception_closed'))
      or (old.state='unknown' and new.state in ('delivered','delivery_failed','blocked','voided','exception_closed'))
      or (old.state='blocked' and new.state in ('draft','required','voided','exception_closed'))
      or (old.state='delivery_failed' and new.state in ('voided','exception_closed'))
      or (old.state='delivered' and new.state='delivered')
      or (old.state='voided' and new.state='voided')
      or (old.state='exception_closed' and new.state='exception_closed')
    ) then
      raise exception 'INVALID_OBLIGATION_TRANSITION' using errcode='40001';
    end if;
  end if;
  new.updated_at:=statement_timestamp();
  return new;
end;
$$;
revoke all on function public.rep_sms_obligation_transition_guard() from public,anon,authenticated,service_role;

create or replace function public.fn_record_rep_sms_delivery(
  p_provider text,p_provider_account_id text,p_provider_message_id text,p_state text,p_provider_status text default null,
  p_provider_error text default null,p_metadata jsonb default '{}'::jsonb,
  p_org_id uuid default null,p_obligation_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_o public.rep_sms_obligations%rowtype;
  v_now timestamptz:=statement_timestamp();
  v_provider text:=nullif(btrim(p_provider),'');
  v_provider_account_id text:=nullif(btrim(p_provider_account_id),'');
  v_provider_message_id text:=nullif(btrim(p_provider_message_id),'');
  v_message_org_id text:=nullif(btrim(coalesce(p_metadata,'{}'::jsonb)->>'messageOrgId'),'');
  v_exact boolean:=p_org_id is not null or p_obligation_id is not null;
begin
  if auth.uid() is not null then
    raise exception 'Provider callbacks are service-only' using errcode='42501';
  end if;
  if v_provider is null or v_provider_account_id is null or v_provider_message_id is null
    or p_state not in ('delivered','delivery_failed','unknown') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if v_exact and (p_org_id is null or p_obligation_id is null) then
    raise exception 'EXACT_OBLIGATION_REQUIRES_ORG' using errcode='22023';
  end if;

  if v_exact then
    select * into v_o from public.rep_sms_obligations
      where id=p_obligation_id and org_id=p_org_id for update;
    if not found then
      return jsonb_build_object('ok',false,'matched',false,'reason','obligation_not_found');
    end if;
    if lower(v_o.provider) is distinct from lower(v_provider)
      or v_o.provider_account_id is distinct from v_provider_account_id then
      return jsonb_build_object('ok',false,'matched',false,'identityMismatch',true);
    end if;
    if v_message_org_id is not null and v_message_org_id<>p_org_id::text then
      return jsonb_build_object('ok',false,'matched',false,'tenantMismatch',true);
    end if;
    if v_o.provider_message_id is not null
      and v_o.provider_message_id is distinct from v_provider_message_id then
      return jsonb_build_object('ok',false,'matched',false,'messageIdMismatch',true);
    end if;
    if exists(
      select 1 from public.rep_sms_obligations other
      where other.org_id=p_org_id and other.provider=v_o.provider
        and other.provider_account_id=v_provider_account_id
        and other.provider_message_id=v_provider_message_id
        and other.id is distinct from v_o.id
    ) then
      return jsonb_build_object('ok',false,'matched',false,'messageIdAlreadyBound',true);
    end if;
    if v_o.provider_message_id is null then
      update public.rep_sms_obligations
        set provider_message_id=v_provider_message_id
        where id=v_o.id;
      v_o.provider_message_id:=v_provider_message_id;
    end if;
  else
    select * into v_o from public.rep_sms_obligations
      where provider=v_provider and provider_account_id=v_provider_account_id
        and provider_message_id=v_provider_message_id for update;
    if not found then return jsonb_build_object('ok',false,'matched',false); end if;
    if v_message_org_id is not null and v_message_org_id<>v_o.org_id::text then
      return jsonb_build_object('ok',false,'matched',false,'tenantMismatch',true);
    end if;
  end if;

  -- A terminal callback is an immutable completion fence. Replays, including
  -- a late accepted result from the send worker, return the stored state.
  if v_o.state in ('delivered','delivery_failed') then
    return jsonb_build_object('ok',true,'matched',true,'state',v_o.state,'duplicate',true,
      'obligationId',v_o.id,'providerMessageId',v_o.provider_message_id);
  end if;
  if v_o.state not in ('sending','accepted','unknown') then
    return jsonb_build_object('ok',false,'matched',true,'state',v_o.state,'reason','callback_state_not_settleable');
  end if;
  if p_state='delivery_failed' and nullif(btrim(p_provider_error),'') is null then
    raise exception 'FAILURE_REQUIRES_REASON' using errcode='22023';
  end if;

  update public.rep_sms_obligations set state=p_state,
    provider_message_id=v_provider_message_id,
    provider_status=coalesce(nullif(btrim(p_provider_status),''),provider_status),
    provider_error=coalesce(nullif(btrim(p_provider_error),''),provider_error),
    last_error=coalesce(nullif(btrim(p_provider_error),''),last_error),
    -- Preserve the claim token for both terminal provider outcomes. This is
    -- the exact completion fence checked by a late accepted result.
    claim_state=case when p_state in ('delivered','delivery_failed') then 'complete' else 'unclaimed' end,
    claim_token=case when p_state in ('delivered','delivery_failed') then coalesce(claim_token,extensions.gen_random_uuid()) else null end,
    claimed_by=case when p_state in ('delivered','delivery_failed') then claimed_by else null end,
    claimed_at=case when p_state in ('delivered','delivery_failed') then claimed_at else null end,
    lease_expires_at=null::timestamptz,
    accepted_at=case when p_state='delivered' then coalesce(accepted_at,v_now) else accepted_at end,
    delivered_at=case when p_state='delivered' then v_now else delivered_at end,
    resolved_at=case when p_state in ('delivered','delivery_failed') then v_now else null end,
    next_attempt_at=case when p_state in ('delivered','delivery_failed') then next_attempt_at else v_now+interval '5 minutes' end
    where id=v_o.id;
  insert into public.rep_sms_obligation_audit(org_id,obligation_id,actor_kind,action,from_state,to_state,reason,metadata)
    values(v_o.org_id,v_o.id,'service','provider_delivery',v_o.state,p_state,p_provider_error,
      jsonb_build_object('exactObligationLookup',v_exact)||coalesce(p_metadata,'{}'::jsonb));
  return jsonb_build_object('ok',true,'matched',true,'state',p_state,'obligationId',v_o.id,
    'providerMessageId',v_provider_message_id);
end;
$$;
revoke all on function public.fn_record_rep_sms_delivery(text,text,text,text,text,text,jsonb,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.fn_record_rep_sms_delivery(text,text,text,text,text,text,jsonb,uuid,uuid)
  to service_role;

comment on constraint rep_sms_obligations_claim_lifecycle_check on public.rep_sms_obligations is
  'Terminal provider delivery_failed rows retain the claim token as an immutable completion fence for late accepted-result idempotency.';

commit;
