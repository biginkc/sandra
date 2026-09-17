begin;

-- The browser's localStorage copy of a generic rep-SMS submission is only a
-- convenience.  A tab can lose it through a reload, a private-browsing
-- policy, or storage eviction while Sendillo is still processing the
-- request.  Keep the reviewed composition and an explicit recovery marker in
-- the service-owned ledger so the server can restore the exact request.
alter table public.rep_sms_delivery_ledger
  add column if not exists composition jsonb not null default '{}'::jsonb,
  add column if not exists recovery_open boolean not null default true,
  add column if not exists recovery_closed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid='public.rep_sms_delivery_ledger'::regclass
       and conname='rep_sms_delivery_ledger_composition_object_check'
  ) then
    alter table public.rep_sms_delivery_ledger
      add constraint rep_sms_delivery_ledger_composition_object_check
      check (jsonb_typeof(composition) = 'object');
  end if;
end;
$$;

-- Rows created before this recovery marker existed may already have a
-- definitive terminal state. Backfill only those safe terminal outcomes;
-- accepted/delivered/unknown/sending/reserved rows stay open so an older
-- provider-backed send cannot be bypassed by a new browser key.
update public.rep_sms_delivery_ledger
   set recovery_open=false,
       recovery_closed_at=coalesce(recovery_closed_at,statement_timestamp())
 where state in ('delivery_failed','blocked','failed_not_dispatched')
   and recovery_open;

create index if not exists rep_sms_delivery_ledger_recovery_idx
  on public.rep_sms_delivery_ledger(org_id,actor_user_id,property_id,contact_id,updated_at desc)
  where recovery_open;

-- Definitive non-delivery outcomes close the recovery draft. Accepted and
-- delivered rows deliberately remain open until a later browser
-- acknowledgement; delivery may win the race before the original action
-- response reaches the browser.
-- Unknown/sending/reserved rows remain open because their provider outcome is
-- unresolved.
create or replace function public.rep_sms_delivery_ledger_recovery_touch()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.state in ('delivery_failed','blocked','failed_not_dispatched') then
    new.recovery_open := false;
    new.recovery_closed_at := coalesce(new.recovery_closed_at,statement_timestamp());
  elsif new.state in ('reserved','sending','unknown')
    and old.state in ('failed_not_dispatched','blocked') then
    new.recovery_open := true;
    new.recovery_closed_at := null;
  end if;
  new.updated_at := statement_timestamp();
  return new;
end;
$$;
revoke all on function public.rep_sms_delivery_ledger_recovery_touch() from public,anon,authenticated,service_role;
drop trigger if exists rep_sms_delivery_ledger_recovery_touch on public.rep_sms_delivery_ledger;
create trigger rep_sms_delivery_ledger_recovery_touch
  before update on public.rep_sms_delivery_ledger
  for each row execute function public.rep_sms_delivery_ledger_recovery_touch();

-- Composition-aware claim wrapper.  The original 14-argument RPC remains in
-- place for old scripts and integrations.  New server code uses this wrapper
-- so the exact approved composition is persisted beside the immutable sender,
-- recipient, and body already stored by the original claim function.
create or replace function public.fn_claim_rep_sms_delivery_with_composition(
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
  p_composition jsonb,
  p_obligation_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_active public.rep_sms_delivery_ledger%rowtype;
  v_claim jsonb;
  v_receipt uuid;
begin
  if auth.uid() is not null and auth.uid() is distinct from p_actor_id then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if p_composition is null or jsonb_typeof(p_composition) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;

  -- Serialize different browser keys for the same actor/lead/contact before
  -- looking for an open row.  This closes the check-then-insert race where
  -- two tabs could otherwise both observe no draft and reserve two sends.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_org_id::text||':'||p_actor_id::text||':'||p_property_id::text||':'||p_contact_id::text,0
  ));

  -- A different browser key cannot bypass an unresolved or recently
  -- accepted request for the same org/actor/lead/contact.  Comparing the
  -- immutable request fields before returning the existing receipt prevents
  -- a changed draft from being reported as the old send.
  select * into v_active
    from public.rep_sms_delivery_ledger l
   where l.org_id=p_org_id
     and l.actor_user_id=p_actor_id
     and l.property_id=p_property_id
     and l.contact_id=p_contact_id
     and l.recovery_open
     and l.state in ('reserved','sending','accepted','delivered','unknown')
   order by l.updated_at desc,l.id desc
   limit 1
   for update;
  if found and v_active.submission_key is distinct from p_submission_key then
    if v_active.sender_assignment_id is distinct from p_sender_assignment_id
      or lower(v_active.provider) is distinct from lower(btrim(p_provider))
      or v_active.provider_account_id is distinct from btrim(p_provider_account_id)
      or v_active.provider_sender_id is distinct from btrim(p_provider_sender_id)
      or v_active.from_number is distinct from p_from_number
      or v_active.to_number is distinct from p_to_number
      or v_active.body is distinct from p_body then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001';
    end if;
    return jsonb_build_object('ok',false,'receiptId',v_active.id,'state',v_active.state,
      'messageId',v_active.message_id,'providerMessageId',v_active.provider_message_id,
      'providerError',v_active.provider_error,'claimGeneration',v_active.claim_generation,
      'reason','already_in_progress');
  end if;

  if found and v_active.composition <> '{}'::jsonb
    and v_active.composition is distinct from p_composition then
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001';
  end if;

  v_claim := public.fn_claim_rep_sms_delivery(
    p_org_id,p_actor_id,p_submission_key,p_property_id,p_contact_id,
    p_sender_assignment_id,p_provider,p_provider_account_id,p_provider_sender_id,
    p_from_number,p_to_number,p_body,p_obligation_id
  );

  v_receipt := nullif(v_claim->>'receiptId','')::uuid;
  if v_receipt is not null then
    update public.rep_sms_delivery_ledger
       set composition=case
         when composition='{}'::jsonb then p_composition
         else composition
       end
     where id=v_receipt;
  end if;
  return v_claim;
end;
$$;
revoke all on function public.fn_claim_rep_sms_delivery_with_composition(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,jsonb,uuid)
  from public,anon,authenticated;
grant execute on function public.fn_claim_rep_sms_delivery_with_composition(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,jsonb,uuid)
  to service_role;

-- Read only the current actor's open recovery draft.  The function repeats
-- the same queue/enrollment scope as the context RPC so the recovery payload
-- cannot be used as a cross-tenant or cross-queue draft lookup.
create or replace function public.fn_get_rep_sms_delivery_draft(p_property_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_org uuid;
  v_contact uuid;
  v_enrolled boolean:=false;
  v_ledger public.rep_sms_delivery_ledger%rowtype;
begin
  select p.org_id,p.homeowner_contact_id into v_org,v_contact
    from public.properties p
   where p.id=p_property_id and p.deleted_at is null;
  if v_org is null or auth.uid() is null then
    raise exception 'Lead unavailable' using errcode='42501';
  end if;
  perform public.my_leads_require_read_scope(v_org,auth.uid());
  if not exists(select 1 from public.memberships m where m.org_id=v_org and m.user_id=auth.uid()
    and (m.acquisitions_enabled or m.role='owner')) then
    raise exception 'Acquisitions access required' using errcode='42501';
  end if;
  if not exists(select 1 from public.my_leads_queue_rows(v_org,auth.uid(),statement_timestamp()) q
    where q.property_id=p_property_id) then
    raise exception 'You can text only leads currently in your queue' using errcode='42501';
  end if;
  select coalesce(e.enabled,false) into v_enrolled
    from public.rep_sms_rollout_enrollments e
   where e.org_id=v_org and e.user_id=auth.uid();
  if not v_enrolled or v_contact is null then
    return jsonb_build_object('draft',null);
  end if;
  select * into v_ledger
    from public.rep_sms_delivery_ledger l
   where l.org_id=v_org
     and l.actor_user_id=auth.uid()
     and l.property_id=p_property_id
     and l.contact_id=v_contact
     and l.recovery_open
     and l.state in ('reserved','sending','accepted','delivered','unknown')
   order by l.updated_at desc,l.id desc
   limit 1;
  if not found then
    return jsonb_build_object('draft',null);
  end if;
  return jsonb_build_object('draft',jsonb_build_object(
    'key',v_ledger.submission_key,
    'receiptId',v_ledger.id,
    'state',v_ledger.state,
    'assignmentId',v_ledger.sender_assignment_id,
    'from',v_ledger.from_number,
    'to',v_ledger.to_number,
    'body',v_ledger.body,
    'composition',v_ledger.composition,
    'providerMessageId',v_ledger.provider_message_id,
    'providerError',v_ledger.provider_error,
    'createdAt',v_ledger.created_at,
    'updatedAt',v_ledger.updated_at
  ));
end;
$$;
revoke all on function public.fn_get_rep_sms_delivery_draft(uuid) from public,anon,service_role;
grant execute on function public.fn_get_rep_sms_delivery_draft(uuid) to authenticated;

-- The browser calls this only after it has received the provider result. The
-- action re-reads the server-owned draft before invoking this service-only
-- function, and the full org/actor/lead/contact/key scope below makes the
-- acknowledgement idempotent and prevents a receipt-only close.
create or replace function public.fn_ack_rep_sms_delivery_draft(
  p_org_id uuid,
  p_actor_id uuid,
  p_property_id uuid,
  p_contact_id uuid,
  p_submission_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_ledger public.rep_sms_delivery_ledger%rowtype;
begin
  if auth.uid() is not null then
    raise exception 'Worker authorization is service-only' using errcode='42501';
  end if;
  if p_org_id is null or p_actor_id is null or p_property_id is null
    or p_contact_id is null or p_submission_key is null then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select * into v_ledger
    from public.rep_sms_delivery_ledger l
   where l.org_id=p_org_id
     and l.actor_user_id=p_actor_id
     and l.property_id=p_property_id
     and l.contact_id=p_contact_id
     and l.submission_key=p_submission_key
   for update;
  if not found then
    return jsonb_build_object('ok',false,'reason','draft_not_found');
  end if;
  if v_ledger.state in ('reserved','sending','unknown') then
    return jsonb_build_object('ok',false,'receiptId',v_ledger.id,'state',v_ledger.state,
      'reason','awaiting_provider_outcome');
  end if;
  update public.rep_sms_delivery_ledger
     set recovery_open=false,
         recovery_closed_at=coalesce(recovery_closed_at,statement_timestamp())
   where id=v_ledger.id and recovery_open;
  return jsonb_build_object('ok',true,'receiptId',v_ledger.id,'state',v_ledger.state,
    'alreadyClosed',not v_ledger.recovery_open);
end;
$$;
revoke all on function public.fn_ack_rep_sms_delivery_draft(uuid,uuid,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.fn_ack_rep_sms_delivery_draft(uuid,uuid,uuid,uuid,uuid)
  to service_role;

commit;
